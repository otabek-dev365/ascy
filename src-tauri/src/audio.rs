//! The arcade's game sound: synthesized here and played through ALSA.
//!
//! WebKitGTK plays Web Audio through GStreamer, which stalls for seconds or
//! stutters on Bluetooth headphones; a plain ALSA stream (PipeWire or
//! PulseAudio behind it on most desktops) plays cleanly. The webview checks
//! what a game asks for (src/arcade/sound.ts) and sends the checked sounds
//! and songs here; one thread mixes every arcade pane and writes to the
//! device, which is opened while something plays and closed when all is quiet.

use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use tauri::State;

const RATE: u32 = 48_000;
const SR: f32 = RATE as f32;
/// Frames rendered and written at a time (~5 ms)
const BLOCK: usize = 256;
/// How much audio the device buffers ahead: enough to ride out a busy moment
const LATENCY_US: u32 = 40_000;
/// The device is closed after this long without sound
const IDLE_FRAMES: u64 = 5 * RATE as u64;
/// Voices playing at once in a pane; more are dropped
const MAX_VOICES: usize = 40;
/// An arpeggio switches notes this often (seconds)
const ARP: f32 = 1.0 / 50.0;
/// A cut sound fades out with this time constant (seconds)
const CUT_FADE: f32 = 0.015;
/// Upper limits, as in sound.ts, so a bad message can't run away
const MAX_TIME: f32 = 3.0;
const MAX_STEPS: u32 = 4096;
const MAX_TRACKS: usize = 8;
const MAX_CHORD: usize = 6;

// ---------- what the webview sends ----------

#[derive(Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Wave {
    Square,
    Sawtooth,
    Triangle,
    Sine,
    Noise,
}

/// One layer of a sound effect, or of a drum hit (see sound.ts)
#[derive(Deserialize, Clone, Debug)]
pub struct Tone {
    wave: Wave,
    freq: [f32; 2],
    time: f32,
    attack: f32,
    hold: f32,
    volume: f32,
    filter: Option<[f32; 2]>,
    vibrato: Option<[f32; 2]>,
    delay: f32,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Instrument {
    wave: Wave,
    volume: f32,
    attack: f32,
    decay: f32,
    sustain: f32,
    release: f32,
    filter: Option<f32>,
    detune: f32,
    vibrato: Option<[f32; 2]>,
    arp: bool,
    pan: f32,
}

#[derive(Deserialize, Debug)]
pub struct Note {
    /// The step it starts on
    at: u32,
    /// Hz, several for a chord
    freqs: Vec<f32>,
    /// Drum hits: indexes into the song's kit
    drums: Vec<usize>,
    /// Length in steps
    steps: u32,
}

#[derive(Deserialize, Debug)]
pub struct Track {
    instrument: Instrument,
    length: u32,
    notes: Vec<Note>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Song {
    bpm: f32,
    steps_per_beat: f32,
    #[serde(rename = "loop")]
    repeat: bool,
    volume: f32,
    length: u32,
    /// The drum sounds, each a few tones
    kit: Vec<Vec<Tone>>,
    tracks: Vec<Track>,
}

#[derive(Deserialize, Debug)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Op {
    /// A sound effect; volume, pan and rate (pitch ×) come from the game
    Sound {
        tones: Vec<Tone>,
        volume: f32,
        pan: f32,
        rate: f32,
    },
    /// Starts a song in place of the one playing; none stops the music
    Music { song: Option<Song> },
    /// 0 mutes
    Volume { volume: f32 },
    /// A pane off screen pauses
    Hidden { hidden: bool },
    /// The game ended: everything fades out
    Stop,
    /// The pane is gone
    Close,
    /// The page (re)loaded: panes of the last page are gone
    Reset,
}

// ---------- voices ----------

/// Low-pass biquad, as Web Audio's (Q of 1 dB)
struct Lowpass {
    cutoff: f64,
    /// Cutoff × this per sample while sliding
    mul: f64,
    slide: u32,
    b: [f32; 3],
    a: [f32; 2],
    z: [f32; 2],
}

impl Lowpass {
    fn new(from: f32, to: f32, samples: u32) -> Self {
        let mut lp = Lowpass {
            cutoff: from as f64,
            mul: slide_mul(from, to, samples),
            slide: if from == to { 0 } else { samples },
            b: [1.0, 0.0, 0.0],
            a: [0.0, 0.0],
            z: [0.0, 0.0],
        };
        lp.tune();
        lp
    }

    fn tune(&mut self) {
        let fc = self.cutoff as f32;
        if fc >= 0.45 * SR {
            self.b = [1.0, 0.0, 0.0];
            self.a = [0.0, 0.0];
            return;
        }
        let w = std::f32::consts::TAU * fc.max(10.0) / SR;
        let alpha = w.sin() / (2.0 * 1.122);
        let cos = w.cos();
        let a0 = 1.0 + alpha;
        let b1 = (1.0 - cos) / a0;
        self.b = [b1 / 2.0, b1, b1 / 2.0];
        self.a = [-2.0 * cos / a0, (1.0 - alpha) / a0];
    }

    fn process(&mut self, x: f32, age: u32) -> f32 {
        if self.slide > 0 {
            self.cutoff *= self.mul;
            self.slide -= 1;
            // Coefficients follow the slide in small steps, as Web Audio's do
            if age.is_multiple_of(32) {
                self.tune();
            }
        }
        let y = self.b[0] * x + self.z[0];
        self.z[0] = self.b[1] * x - self.a[0] * y + self.z[1];
        self.z[1] = self.b[2] * x - self.a[1] * y;
        y
    }
}

/// Multiplier per sample that slides `from` to `to` exponentially
fn slide_mul(from: f32, to: f32, samples: u32) -> f64 {
    if from == to || samples == 0 || from <= 0.0 || to <= 0.0 {
        1.0
    } else {
        (to as f64 / from as f64).powf(1.0 / samples as f64)
    }
}

enum Pitch {
    Slide {
        freq: f64,
        mul: f64,
        left: u32,
    },
    /// A chord as an arpeggio: the notes take turns every `every` samples,
    /// until the note ends at `last` turns
    Arp {
        freqs: [f32; MAX_CHORD],
        len: usize,
        every: u32,
        last: u32,
    },
}

impl Pitch {
    fn next(&mut self, age: u32) -> f32 {
        match self {
            Pitch::Slide { freq, mul, left } => {
                let f = *freq as f32;
                if *left > 0 {
                    *freq *= *mul;
                    *left -= 1;
                }
                f
            }
            Pitch::Arp {
                freqs,
                len,
                every,
                last,
            } => freqs[((age / *every).min(*last) as usize) % *len],
        }
    }
}

/// An envelope: segments starting at given samples, each optionally setting
/// the level and then moving it by `level = level * mul + add` per sample —
/// enough for linear ramps, holds and exponential curves.
#[derive(Clone, Copy)]
struct Seg {
    from: u64,
    set: Option<f32>,
    mul: f32,
    add: f32,
}

struct Env {
    level: f32,
    segs: [Seg; 4],
    len: usize,
    /// The next segment to enter
    next: usize,
    mul: f32,
    add: f32,
}

impl Env {
    fn new(segs: &[Seg]) -> Self {
        let mut env = Env {
            level: 0.0,
            segs: [Seg {
                from: 0,
                set: None,
                mul: 1.0,
                add: 0.0,
            }; 4],
            len: segs.len(),
            next: 0,
            mul: 1.0,
            add: 0.0,
        };
        env.segs[..segs.len()].copy_from_slice(segs);
        env
    }

    fn next(&mut self, t: u64) -> f32 {
        while self.next < self.len && t >= self.segs[self.next].from {
            let s = self.segs[self.next];
            if let Some(v) = s.set {
                self.level = v;
            }
            self.mul = s.mul;
            self.add = s.add;
            self.next += 1;
        }
        let v = self.level;
        self.level = self.level * self.mul + self.add;
        v
    }
}

/// Per-sample multiplier of an exponential decay with time constant `tau` seconds
fn decay(tau: f32) -> f32 {
    (-1.0 / (tau * SR)).exp()
}

fn samples(seconds: f32) -> u64 {
    (seconds.max(0.0) * SR).round() as u64
}

/// Web Audio's panning: none leaves both sides at full volume, any pan is equal-power
fn pan_gains(pan: f32) -> (f32, f32) {
    if pan == 0.0 {
        return (1.0, 1.0);
    }
    let x = (pan.clamp(-1.0, 1.0) + 1.0) * std::f32::consts::FRAC_PI_4;
    (x.cos(), x.sin())
}

/// PolyBLEP: smooths the jumps of square and saw waves, which would otherwise alias
fn blep(t: f32, dt: f32) -> f32 {
    if t < dt {
        let x = t / dt;
        2.0 * x - x * x - 1.0
    } else if t > 1.0 - dt {
        let x = (t - 1.0) / dt;
        x * x + 2.0 * x + 1.0
    } else {
        0.0
    }
}

struct Voice {
    start: u64,
    stop: u64,
    wave: Wave,
    phase: f32,
    /// Noise: the random values it moves between, and its generator
    noise: [f32; 2],
    seed: u32,
    pitch: Pitch,
    /// Vibrato: phase step per sample and depth in Hz
    vibrato: Option<(f32, f32)>,
    vib_phase: f32,
    detune: f32,
    filter: Option<Lowpass>,
    env: Env,
    left: f32,
    right: f32,
    music: bool,
    /// 1 until the voice is cut, then fading to nothing
    fade: f32,
    fading: bool,
}

impl Voice {
    fn osc(&mut self, freq: f32) -> f32 {
        if self.wave == Wave::Noise {
            // Noise "pitch" is how often it takes a new random value; in
            // between it slides linearly, as Web Audio's resampled noise does
            self.phase += freq / SR;
            let mut turns = 0;
            while self.phase >= 1.0 {
                self.phase -= 1.0;
                turns += 1;
                if turns <= 4 {
                    self.seed ^= self.seed << 13;
                    self.seed ^= self.seed >> 17;
                    self.seed ^= self.seed << 5;
                    self.noise = [
                        self.noise[1],
                        self.seed as f32 / u32::MAX as f32 * 2.0 - 1.0,
                    ];
                }
            }
            return self.noise[0] + (self.noise[1] - self.noise[0]) * self.phase;
        }
        let dt = freq / SR;
        // Above the Nyquist frequency a band-limited oscillator is silent
        if !(0.0..0.5).contains(&dt) {
            return 0.0;
        }
        let t = self.phase;
        self.phase += dt;
        if self.phase >= 1.0 {
            self.phase -= 1.0;
        }
        match self.wave {
            Wave::Sine => (std::f32::consts::TAU * t).sin(),
            Wave::Square => {
                let v = if t < 0.5 { 1.0 } else { -1.0 };
                v + blep(t, dt) - blep((t + 0.5) % 1.0, dt)
            }
            Wave::Sawtooth => 2.0 * t - 1.0 - blep(t, dt),
            Wave::Triangle => 1.0 - 4.0 * (((t + 0.25) % 1.0) - 0.5).abs(),
            Wave::Noise => unreachable!(),
        }
    }

    /// Adds this voice to `out` (which starts at sample `now`); false once it is over
    fn render(&mut self, now: u64, out: &mut [[f32; 2]]) -> bool {
        let cut = decay(CUT_FADE);
        for (i, frame) in out.iter_mut().enumerate() {
            let t = now + i as u64;
            if t < self.start {
                continue;
            }
            if t >= self.stop || self.fade < 1e-4 {
                return false;
            }
            let age = (t - self.start) as u32;
            let mut f = self.pitch.next(age);
            if let Some((step, depth)) = self.vibrato {
                f += depth * self.vib_phase.sin();
                self.vib_phase = (self.vib_phase + step) % std::f32::consts::TAU;
            }
            let mut x = self.osc(f * self.detune);
            if let Some(lp) = &mut self.filter {
                x = lp.process(x, age);
            }
            x *= self.env.next(t);
            if self.fading {
                self.fade *= cut;
                x *= self.fade;
            }
            frame[0] += x * self.left;
            frame[1] += x * self.right;
        }
        true
    }
}

fn seed(start: u64, n: usize) -> u32 {
    // Any non-zero value works; differing ones keep noise layers apart
    ((start as u32) ^ (n as u32).wrapping_mul(0x9e37_79b9)) | 1
}

/// One layer of a sound effect or drum hit, starting at `start`
fn tone_voice(
    tone: &Tone,
    start: u64,
    gain: f32,
    pan: f32,
    rate: f32,
    music: bool,
    n: usize,
) -> Voice {
    let time = tone.time.clamp(0.005, MAX_TIME);
    let len = samples(time).max(1);
    let f0 = tone.freq[0].max(1.0) * rate;
    let f1 = tone.freq[1].max(1.0) * rate;
    let attack = samples(tone.attack.clamp(0.0, time)).min(len);
    let fade_at = (attack + samples(tone.hold.max(0.0))).min(len);
    let v = tone.volume.clamp(0.0, 1.0) * gain;
    // Up to full volume, held there, then down to silence (0.0001) at the end
    let fall = if v > 1e-4 && len > fade_at {
        (1e-4 / v).powf(1.0 / (len - fade_at) as f32)
    } else {
        1.0
    };
    let mut segs = Vec::with_capacity(3);
    if attack > 0 {
        segs.push(Seg {
            from: start,
            set: Some(0.0),
            mul: 1.0,
            add: v / attack as f32,
        });
    }
    segs.push(Seg {
        from: start + attack,
        set: Some(v),
        mul: 1.0,
        add: 0.0,
    });
    segs.push(Seg {
        from: start + fade_at,
        set: Some(v),
        mul: fall,
        add: 0.0,
    });
    let (left, right) = pan_gains(pan);
    Voice {
        start,
        stop: start + len,
        wave: tone.wave,
        phase: 0.0,
        noise: [0.0, 0.0],
        seed: seed(start, n),
        pitch: Pitch::Slide {
            freq: f0 as f64,
            mul: slide_mul(f0, f1, len as u32),
            left: len as u32,
        },
        vibrato: tone
            .vibrato
            .map(|[r, d]| (std::f32::consts::TAU * r / SR, d * f0)),
        vib_phase: 0.0,
        detune: 1.0,
        filter: tone.filter.map(|[a, b]| Lowpass::new(a, b, len as u32)),
        env: Env::new(&segs),
        left,
        right,
        music,
        fade: 1.0,
        fading: false,
    }
}

/// A note of a music track: attack, decay to the sustain level while the note
/// lasts, then release. `freqs` are a chord played as an arpeggio.
fn note_voice(
    inst: &Instrument,
    freqs: &[f32],
    start: u64,
    length: f32,
    k: f32,
    gain: f32,
    n: usize,
) -> Voice {
    let len = samples((length - 0.004).max(0.01));
    let end = start + len;
    let attack = samples(inst.attack.max(0.0));
    let rise = attack.min(len);
    let v = inst.volume.clamp(0.0, 1.0) * k * gain;
    let mut segs = Vec::with_capacity(3);
    if rise > 0 {
        segs.push(Seg {
            from: start,
            set: Some(0.0),
            mul: 1.0,
            add: v / rise as f32,
        });
    }
    if attack < len {
        let m = decay((inst.decay / 3.0).max(0.001));
        let target = v * inst.sustain.clamp(0.0, 1.0);
        segs.push(Seg {
            from: start + attack,
            set: Some(v),
            mul: m,
            add: target * (1.0 - m),
        });
    } else {
        segs.push(Seg {
            from: end,
            set: Some(v),
            mul: 1.0,
            add: 0.0,
        });
    }
    segs.push(Seg {
        from: end,
        set: None,
        mul: decay((inst.release / 4.0).max(0.004)),
        add: 0.0,
    });
    let freqs = &freqs[..freqs.len().min(MAX_CHORD)];
    let base = freqs[0].max(1.0);
    let pitch = if freqs.len() > 1 {
        let mut arp = [0.0; MAX_CHORD];
        arp[..freqs.len()].copy_from_slice(freqs);
        let every = samples(ARP) as u32;
        Pitch::Arp {
            freqs: arp,
            len: freqs.len(),
            every,
            last: (len as u32).div_ceil(every).max(1) - 1,
        }
    } else {
        Pitch::Slide {
            freq: base as f64,
            mul: 1.0,
            left: 0,
        }
    };
    let (left, right) = pan_gains(inst.pan);
    Voice {
        start,
        stop: end + samples(inst.release.max(0.0) + 0.05),
        wave: inst.wave,
        phase: 0.0,
        noise: [0.0, 0.0],
        seed: seed(start, n),
        pitch,
        vibrato: inst
            .vibrato
            .map(|[r, d]| (std::f32::consts::TAU * r / SR, d * base)),
        vib_phase: 0.0,
        detune: if inst.wave == Wave::Noise {
            1.0
        } else {
            2f32.powf(inst.detune / 1200.0)
        },
        filter: inst.filter.map(|f| Lowpass::new(f, f, 0)),
        env: Env::new(&segs),
        left,
        right,
        music: true,
        fade: 1.0,
        fading: false,
    }
}

// ---------- panes ----------

struct Playing {
    song: Song,
    /// For each track, the note starting at each step
    at: Vec<Vec<Option<usize>>>,
    step: u32,
    /// The sample the next step starts on
    next: f64,
    step_len: f64,
}

impl Playing {
    fn new(mut song: Song, now: u64) -> Self {
        song.tracks.truncate(MAX_TRACKS);
        let at = song
            .tracks
            .iter()
            .map(|t| {
                let mut at = vec![None; t.length.clamp(1, MAX_STEPS) as usize];
                for (i, n) in t.notes.iter().enumerate() {
                    if let Some(slot) = at.get_mut(n.at as usize) {
                        *slot = Some(i);
                    }
                }
                at
            })
            .collect();
        let step_len =
            60.0 / song.bpm.clamp(30.0, 300.0) as f64 / song.steps_per_beat.clamp(1.0, 8.0) as f64
                * SR as f64;
        song.length = song.length.clamp(1, MAX_STEPS);
        Playing {
            song,
            at,
            step: 0,
            next: now as f64,
            step_len,
        }
    }
}

struct Pane {
    volume: f32,
    hidden: bool,
    /// Samples played: the pane's own clock, which stops while it is paused
    now: u64,
    voices: Vec<Voice>,
    playing: Option<Playing>,
    /// The song the game asked for waits here while the pane is muted
    muted_song: Option<Song>,
    made: usize,
}

impl Pane {
    fn new() -> Self {
        Pane {
            volume: 0.6,
            hidden: false,
            now: 0,
            voices: Vec::new(),
            playing: None,
            muted_song: None,
            made: 0,
        }
    }

    fn audible(&self) -> bool {
        !self.hidden && self.volume > 0.0
    }

    fn busy(&self) -> bool {
        self.audible() && (!self.voices.is_empty() || self.playing.is_some())
    }

    fn add(&mut self, voice: Voice) {
        if self.voices.len() < MAX_VOICES {
            self.voices.push(voice);
            self.made += 1;
        }
    }

    /// Fades out what plays on the music bus, or on the effects bus
    fn cut(&mut self, music: bool) {
        for v in self.voices.iter_mut().filter(|v| v.music == music) {
            v.fading = true;
        }
    }

    fn apply(&mut self, op: Op) {
        match op {
            Op::Sound {
                tones,
                volume,
                pan,
                rate,
            } => {
                if !self.audible() {
                    return;
                }
                let rate = rate.clamp(0.25, 4.0);
                for tone in tones.iter().take(8) {
                    let start = self.now + samples(tone.delay.min(2.0));
                    let voice = tone_voice(
                        tone,
                        start,
                        volume.clamp(0.0, 1.0),
                        pan,
                        rate,
                        false,
                        self.made,
                    );
                    self.add(voice);
                }
            }
            Op::Music { song } => {
                self.cut(true);
                self.playing = None;
                self.muted_song = None;
                if let Some(song) = song {
                    if self.volume > 0.0 {
                        self.playing = Some(Playing::new(song, self.now));
                    } else {
                        self.muted_song = Some(song);
                    }
                }
            }
            Op::Volume { volume } => {
                let volume = volume.clamp(0.0, 1.0);
                if volume == 0.0 && self.volume > 0.0 {
                    // Muted: nothing more to hear, and the song starts over when unmuted
                    self.voices.clear();
                    self.muted_song = self.playing.take().map(|p| p.song);
                } else if volume > 0.0 && self.volume == 0.0 {
                    self.playing = self.muted_song.take().map(|s| Playing::new(s, self.now));
                }
                self.volume = volume;
            }
            Op::Hidden { hidden } => self.hidden = hidden,
            Op::Stop => {
                self.playing = None;
                self.muted_song = None;
                self.cut(true);
                self.cut(false);
            }
            Op::Close | Op::Reset => {}
        }
    }

    /// Starts the notes of the steps that begin before `until`
    fn sequence(&mut self, until: u64) {
        while let Some(p) = &mut self.playing {
            if p.next >= until as f64 {
                return;
            }
            if p.step >= p.song.length {
                if !p.song.repeat {
                    self.playing = None;
                    return;
                }
                p.step = 0;
            }
            let start = (p.next.round() as u64).max(self.now);
            let step_secs = (p.step_len / SR as f64) as f32;
            let mut voices = Vec::new();
            for (track, at) in p.song.tracks.iter().zip(&p.at) {
                let Some(i) = at[(p.step % at.len() as u32) as usize] else {
                    continue;
                };
                let note = &track.notes[i];
                let inst = &track.instrument;
                for &d in &note.drums {
                    for tone in p.song.kit.get(d).into_iter().flatten() {
                        voices.push(tone_voice(
                            tone,
                            start,
                            inst.volume * p.song.volume,
                            inst.pan,
                            1.0,
                            true,
                            self.made + voices.len(),
                        ));
                    }
                }
                if note.freqs.is_empty() {
                    continue;
                }
                let length = note.steps.max(1) as f32 * step_secs;
                if note.freqs.len() > 1 && !inst.arp {
                    let k = 1.0 / (note.freqs.len() as f32).sqrt();
                    for f in note.freqs.iter().take(MAX_CHORD) {
                        voices.push(note_voice(
                            inst,
                            &[*f],
                            start,
                            length,
                            k,
                            p.song.volume,
                            self.made + voices.len(),
                        ));
                    }
                } else {
                    voices.push(note_voice(
                        inst,
                        &note.freqs,
                        start,
                        length,
                        1.0,
                        p.song.volume,
                        self.made + voices.len(),
                    ));
                }
            }
            p.step += 1;
            p.next += p.step_len;
            for v in voices {
                self.add(v);
            }
        }
    }

    fn render(&mut self, out: &mut [[f32; 2]], scratch: &mut [[f32; 2]]) {
        if !self.audible() {
            return;
        }
        let n = out.len() as u64;
        self.sequence(self.now + n);
        scratch.fill([0.0, 0.0]);
        let now = self.now;
        self.voices.retain_mut(|v| v.render(now, scratch));
        for (o, s) in out.iter_mut().zip(scratch.iter()) {
            o[0] += s[0] * self.volume;
            o[1] += s[1] * self.volume;
        }
        self.now += n;
    }
}

/// The compressor at the end of the mix, as the Web Audio version had:
/// threshold −10 dB, knee 6 dB, ratio 12, with the makeup gain WebKit adds.
/// No game can get painfully loud, and quiet ones still carry.
struct Limiter {
    level: f32,
}

impl Limiter {
    const MAKEUP: f32 = 1.88;

    fn gain(level: f32) -> f32 {
        if level < 1e-5 {
            return 1.0;
        }
        let (threshold, knee, ratio) = (-10.0f32, 6.0f32, 12.0f32);
        let x = 20.0 * level.log10();
        let over = x - threshold;
        let y = if 2.0 * over < -knee {
            x
        } else if 2.0 * over.abs() <= knee {
            x + (1.0 / ratio - 1.0) * (over + knee / 2.0).powi(2) / (2.0 * knee)
        } else {
            threshold + over / ratio
        };
        10f32.powf((y - x) / 20.0)
    }

    fn process(&mut self, frame: [f32; 2]) -> [f32; 2] {
        let peak = frame[0].abs().max(frame[1].abs());
        let k = if peak > self.level {
            decay(0.003)
        } else {
            decay(0.2)
        };
        self.level = peak + (self.level - peak) * k;
        let g = Self::gain(self.level) * Self::MAKEUP;
        [soft_clip(frame[0] * g), soft_clip(frame[1] * g)]
    }
}

/// Leaves the signal alone below 0.9 and bends it smoothly under 1 above
fn soft_clip(x: f32) -> f32 {
    let a = x.abs();
    if a <= 0.9 {
        x
    } else {
        (0.9 + 0.1 * ((a - 0.9) / 0.1).tanh()).copysign(x)
    }
}

#[derive(Default)]
struct Mixer {
    panes: HashMap<String, Pane>,
    limiter: Option<Limiter>,
    /// No ALSA here: nothing is ever played
    disabled: bool,
}

impl Mixer {
    fn busy(&self) -> bool {
        self.panes.values().any(Pane::busy)
    }

    fn apply(&mut self, pane: &str, ops: Vec<Op>) {
        for op in ops {
            match op {
                Op::Close => {
                    self.panes.remove(pane);
                }
                Op::Reset => self.panes.clear(),
                op => self
                    .panes
                    .entry(pane.to_owned())
                    .or_insert_with(Pane::new)
                    .apply(op),
            }
        }
    }

    fn render(&mut self, out: &mut [i16]) {
        let mut mix = [[0.0f32; 2]; BLOCK];
        let mut scratch = [[0.0f32; 2]; BLOCK];
        let frames = out.len() / 2;
        for pane in self.panes.values_mut() {
            pane.render(&mut mix[..frames], &mut scratch[..frames]);
        }
        let limiter = self.limiter.get_or_insert(Limiter { level: 0.0 });
        for (o, m) in out.chunks_exact_mut(2).zip(mix.iter()) {
            let [l, r] = limiter.process(*m);
            o[0] = (l * 32767.0) as i16;
            o[1] = (r * 32767.0) as i16;
        }
    }

    /// Drops what is playing, for when the device fails
    fn silence(&mut self) {
        for pane in self.panes.values_mut() {
            pane.voices.clear();
        }
    }
}

// ---------- the device ----------

#[cfg(target_os = "linux")]
mod alsa {
    //! The few ALSA calls needed, loaded at run time: libasound is on every
    //! Linux desktop, and building needs no ALSA headers
    use std::ffi::{c_char, c_int, c_long, c_uint, c_ulong, c_void};

    type Open = unsafe extern "C" fn(*mut *mut c_void, *const c_char, c_int, c_int) -> c_int;
    type SetParams =
        unsafe extern "C" fn(*mut c_void, c_int, c_int, c_uint, c_uint, c_int, c_uint) -> c_int;
    type Writei = unsafe extern "C" fn(*mut c_void, *const c_void, c_ulong) -> c_long;
    type Recover = unsafe extern "C" fn(*mut c_void, c_int, c_int) -> c_int;
    type Close = unsafe extern "C" fn(*mut c_void) -> c_int;

    const STREAM_PLAYBACK: c_int = 0;
    const FORMAT_S16_LE: c_int = 2;
    const ACCESS_RW_INTERLEAVED: c_int = 3;

    pub struct Alsa {
        open: Open,
        set_params: SetParams,
        writei: Writei,
        recover: Recover,
        close: Close,
    }

    pub struct Pcm<'a> {
        alsa: &'a Alsa,
        handle: *mut c_void,
    }

    impl Alsa {
        pub fn load() -> Option<Alsa> {
            // SAFETY: dlopen/dlsym with valid C strings; each symbol is cast to
            // the signature documented for it in alsa/pcm.h
            unsafe {
                let lib = libc::dlopen(
                    c"libasound.so.2".as_ptr(),
                    libc::RTLD_NOW | libc::RTLD_LOCAL,
                );
                if lib.is_null() {
                    return None;
                }
                let sym = |name: &std::ffi::CStr| {
                    let p = libc::dlsym(lib, name.as_ptr());
                    (!p.is_null()).then_some(p)
                };
                Some(Alsa {
                    open: std::mem::transmute::<*mut c_void, Open>(sym(c"snd_pcm_open")?),
                    set_params: std::mem::transmute::<*mut c_void, SetParams>(sym(
                        c"snd_pcm_set_params",
                    )?),
                    writei: std::mem::transmute::<*mut c_void, Writei>(sym(c"snd_pcm_writei")?),
                    recover: std::mem::transmute::<*mut c_void, Recover>(sym(c"snd_pcm_recover")?),
                    close: std::mem::transmute::<*mut c_void, Close>(sym(c"snd_pcm_close")?),
                })
            }
        }

        /// The default device: 16-bit stereo at `rate`, `latency_us` buffered
        pub fn open(&self, rate: u32, latency_us: u32) -> Option<Pcm<'_>> {
            let mut handle = std::ptr::null_mut();
            // SAFETY: calls into libasound with a valid out-pointer and C string;
            // the handle is closed again on failure
            unsafe {
                if (self.open)(&mut handle, c"default".as_ptr(), STREAM_PLAYBACK, 0) < 0 {
                    return None;
                }
                if (self.set_params)(
                    handle,
                    FORMAT_S16_LE,
                    ACCESS_RW_INTERLEAVED,
                    2,
                    rate,
                    1,
                    latency_us,
                ) < 0
                {
                    (self.close)(handle);
                    return None;
                }
            }
            Some(Pcm { alsa: self, handle })
        }
    }

    impl Pcm<'_> {
        /// Writes interleaved stereo frames, waiting for room; false if the device failed
        pub fn write(&mut self, mut data: &[i16]) -> bool {
            while !data.is_empty() {
                // SAFETY: `data` holds data.len() / 2 whole stereo frames
                let n = unsafe {
                    (self.alsa.writei)(
                        self.handle,
                        data.as_ptr().cast(),
                        (data.len() / 2) as c_ulong,
                    )
                };
                if n < 0 {
                    // An underrun or a suspend: recover and carry on
                    // SAFETY: valid handle; the error code came from ALSA
                    if unsafe { (self.alsa.recover)(self.handle, n as c_int, 1) } < 0 {
                        return false;
                    }
                } else {
                    data = &data[n as usize * 2..];
                }
            }
            true
        }
    }

    impl Drop for Pcm<'_> {
        fn drop(&mut self) {
            // SAFETY: the handle came from snd_pcm_open and is closed once
            unsafe { (self.alsa.close)(self.handle) };
        }
    }
}

#[derive(Default)]
struct Shared {
    mixer: Mutex<Mixer>,
    wake: Condvar,
}

/// Opens the device while something plays, mixes, and closes it again when
/// all has been quiet for a while
#[cfg(target_os = "linux")]
fn output(shared: Arc<Shared>) {
    let Some(alsa) = alsa::Alsa::load() else {
        eprintln!("arcade sound: libasound.so.2 not found, games play silently");
        shared.mixer.lock().unwrap().disabled = true;
        return;
    };
    let mut buf = [0i16; BLOCK * 2];
    loop {
        {
            let mut mixer = shared.mixer.lock().unwrap();
            while !mixer.busy() {
                mixer = shared.wake.wait(mixer).unwrap();
            }
        }
        let Some(mut pcm) = alsa.open(RATE, LATENCY_US) else {
            eprintln!("arcade sound: can't open the default ALSA device");
            shared.mixer.lock().unwrap().silence();
            std::thread::sleep(std::time::Duration::from_secs(2));
            continue;
        };
        let mut quiet = 0;
        loop {
            let busy = {
                let mut mixer = shared.mixer.lock().unwrap();
                mixer.render(&mut buf);
                mixer.busy()
            };
            if !pcm.write(&buf) {
                shared.mixer.lock().unwrap().silence();
                break;
            }
            quiet = if busy { 0 } else { quiet + BLOCK as u64 };
            if quiet > IDLE_FRAMES {
                break;
            }
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn output(shared: Arc<Shared>) {
    shared.mixer.lock().unwrap().disabled = true;
}

#[derive(Default)]
pub struct Audio {
    shared: Arc<Shared>,
    started: OnceLock<()>,
}

/// Sound for an arcade pane: the webview batches what happened since the
/// last call, in order
#[tauri::command]
pub fn arcade_audio(audio: State<Audio>, pane: String, ops: Vec<Op>) {
    let mut mixer = audio.shared.mixer.lock().unwrap();
    if mixer.disabled {
        return;
    }
    mixer.apply(&pane, ops);
    if mixer.busy() {
        // The output thread (and libasound) only once a game makes a sound
        audio.started.get_or_init(|| {
            let shared = audio.shared.clone();
            let _ = std::thread::Builder::new()
                .name("arcade-audio".into())
                .spawn(move || output(shared));
        });
        audio.shared.wake.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(wave: Wave, freq: f32, time: f32) -> Tone {
        Tone {
            wave,
            freq: [freq, freq],
            time,
            attack: 0.003,
            hold: 0.0,
            volume: 0.5,
            filter: None,
            vibrato: None,
            delay: 0.0,
        }
    }

    fn inst(wave: Wave) -> Instrument {
        Instrument {
            wave,
            volume: 0.5,
            attack: 0.005,
            decay: 0.1,
            sustain: 0.7,
            release: 0.05,
            filter: None,
            detune: 0.0,
            vibrato: None,
            arp: false,
            pan: 0.0,
        }
    }

    /// Renders `seconds` of the mix; returns the peak of every two blocks (~11 ms)
    fn run(mixer: &mut Mixer, seconds: f32) -> Vec<i16> {
        let mut peaks = Vec::new();
        let mut buf = [0i16; BLOCK * 2];
        let mut window = 0i16;
        for i in 0..(seconds * SR) as usize / BLOCK {
            mixer.render(&mut buf);
            window = window.max(buf.iter().map(|s| s.saturating_abs()).max().unwrap());
            if (i + 1) % 2 == 0 {
                peaks.push(window);
                window = 0;
            }
        }
        peaks
    }

    #[test]
    fn a_sound_plays_and_ends() {
        let mut m = Mixer::default();
        let tones = vec![
            tone(Wave::Square, 440.0, 0.2),
            tone(Wave::Noise, 8000.0, 0.1),
        ];
        m.apply(
            "a",
            vec![Op::Sound {
                tones,
                volume: 1.0,
                pan: 0.3,
                rate: 1.0,
            }],
        );
        assert!(m.busy());
        let peaks = run(&mut m, 0.5);
        assert!(peaks[..3].iter().all(|&p| p > 1000), "{peaks:?}");
        assert!(peaks[30..].iter().all(|&p| p == 0), "{peaks:?}");
        assert!(!m.busy());
    }

    #[test]
    fn music_loops_and_stop_fades_it() {
        let mut m = Mixer::default();
        let note = |at, freqs: Vec<f32>, drums: Vec<usize>| Note {
            at,
            freqs,
            drums,
            steps: 1,
        };
        let song = Song {
            bpm: 120.0,
            steps_per_beat: 4.0,
            repeat: true,
            volume: 0.6,
            length: 4,
            kit: vec![vec![tone(Wave::Noise, 40000.0, 0.05)]],
            tracks: vec![
                Track {
                    instrument: inst(Wave::Triangle),
                    length: 4,
                    notes: vec![
                        note(0, vec![220.0], vec![]),
                        note(2, vec![262.0, 330.0, 392.0], vec![]),
                    ],
                },
                Track {
                    instrument: Instrument {
                        arp: true,
                        ..inst(Wave::Square)
                    },
                    length: 2,
                    notes: vec![note(1, vec![440.0, 550.0], vec![])],
                },
                Track {
                    instrument: inst(Wave::Noise),
                    length: 1,
                    notes: vec![note(0, vec![], vec![0, 7])],
                },
            ],
        };
        m.apply("a", vec![Op::Music { song: Some(song) }]);
        let peaks = run(&mut m, 2.0);
        assert!(peaks.iter().all(|&p| p > 500), "{peaks:?}");
        m.apply("a", vec![Op::Stop]);
        let after = run(&mut m, 0.3);
        assert!(
            after[after.len() - 5..].iter().all(|&p| p < 50),
            "{after:?}"
        );
        assert!(!m.busy());
    }

    #[test]
    fn hidden_and_muted_panes_wait() {
        let mut m = Mixer::default();
        let tones = vec![tone(Wave::Sine, 440.0, 0.3)];
        m.apply(
            "a",
            vec![
                Op::Hidden { hidden: true },
                Op::Sound {
                    tones: tones.clone(),
                    volume: 1.0,
                    pan: 0.0,
                    rate: 1.0,
                },
            ],
        );
        assert!(!m.busy(), "a hidden pane takes no new sounds");
        m.apply(
            "a",
            vec![
                Op::Hidden { hidden: false },
                Op::Sound {
                    tones,
                    volume: 1.0,
                    pan: 0.0,
                    rate: 1.0,
                },
                Op::Hidden { hidden: true },
            ],
        );
        assert!(run(&mut m, 0.5).iter().all(|&p| p == 0));
        m.apply("a", vec![Op::Hidden { hidden: false }]);
        assert!(
            run(&mut m, 0.1).iter().all(|&p| p > 1000),
            "the sound resumes where it paused"
        );
        m.apply("a", vec![Op::Volume { volume: 0.0 }]);
        assert!(!m.busy());
        m.apply("a", vec![Op::Close]);
        assert!(m.panes.is_empty());
    }

    #[test]
    fn the_limiter_keeps_it_in_range() {
        let mut m = Mixer::default();
        let loud = vec![tone(Wave::Square, 110.0, 1.0); 8];
        for pane in ["a", "b", "c"] {
            m.apply(
                pane,
                vec![
                    Op::Volume { volume: 1.0 },
                    Op::Sound {
                        tones: loud.clone(),
                        volume: 1.0,
                        pan: 0.0,
                        rate: 1.0,
                    },
                ],
            );
        }
        let peaks = run(&mut m, 0.5);
        // Past the first few milliseconds the compressor holds it well under full scale
        assert!(peaks[1..].iter().all(|&p| p < 30000), "{peaks:?}");
    }
}
