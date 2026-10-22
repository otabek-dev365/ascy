# Ascy

*"ASK-ee" deb o'qiladi — ASCII kabi.*

Terminal emulyator — Tauri 2 (Rust) + xterm.js 6. Hacker-uslub: qora fon, fosfor-yashil matn, orqada Matrix yomg'iri.

## Imkoniyatlar

- Tablar va split-panellar (ichma-ich, sichqoncha bilan o'lchanadi)
- Ikki tema: `hacker` va `night` (Tokyo Night uslubi)
- Matrix fon animatsiyasi (sozlanadigan qoraytirish pardasi bilan)
- Yangi tab/panel faol shell'ning papkasida ochiladi
- Scrollback ichida qidiruv, URL'lar Ctrl+klik bilan ochiladi
- Fayl sudrab tashlansa, yo'li terminalga yoziladi (drag & drop)
- Sozlamalar JSON faylda, qayta ishga tushirmasdan qo'llanadi
- ☰ menyu: tema, matrix, parda va shrift jonli slayderlar bilan

## Tugmalar

| Tugma | Vazifa |
|---|---|
| `Ctrl+Shift+T` / `W` | Yangi tab / panelni yopish |
| `Ctrl+PgUp` / `PgDn` | Tablar orasida yurish |
| `Alt+1..9` | N-tabga sakrash |
| `Ctrl+Shift+E` / `O` | Split: yonma-yon / tepama-tepa |
| `Alt+←→↑↓` | Panellar orasida yurish |
| `Ctrl+Shift+C` / `V` | Nusxalash / qo'yish |
| `Ctrl+Shift+F` | Qidiruv (Enter — keyingi, Shift+Enter — oldingi, Esc — yopish) |
| `Ctrl` + `+` / `-` / `0` | Shrift kattaroq / kichikroq / aslicha |
| `Ctrl+Shift+M` | Matrix yoqish/o'chirish |
| `Ctrl+Shift+P` | Tema almashtirish (hacker ⇄ night) |
| `Ctrl+,` | Sozlamalar faylini ochish |
| `Ctrl+Shift+R` | Sozlamalarni qayta yuklash |

## Sozlamalar

`~/.config/uz.otabek.ascy/settings.json`:

```json
{
  "fontFamily": "...",   // shriftlar ro'yxati
  "fontSize": 14,
  "theme": "hacker",     // "hacker" | "night"
  "matrix": true,        // fon animatsiyasi
  "shade": 0.28,         // matrix qoraytirishi: 0 (yo'q) .. 0.9 (qora)
  "scrollback": 10000    // tarix qatorlari
}
```

## Ishlab chiqish

```bash
npm install               # birinchi marta
npm run tauri dev         # dev-rejim (hot reload)
npm run tauri build       # release + .deb paket
```

`.deb` natijasi: `src-tauri/target/release/bundle/deb/` — o'rnatish:
`sudo apt install ./Ascy_*.deb`, o'chirish: `sudo apt remove ascy`.

Talablar: Node.js, Rust (rustup), `libwebkit2gtk-4.1-dev`, `librsvg2-dev` (faqat paket yig'ish uchun).

## Tuzilma

```
src/                    # frontend (TypeScript)
  main.ts               #   tab/panel boshqaruvi, tugmalar
  theme.ts              #   temalar (hacker, night)
  matrix.ts             #   Matrix yomg'iri (canvas)
  settings.ts           #   sozlamalarni yuklash/saqlash
src-tauri/src/lib.rs    # backend (Rust): PTY, sozlamalar buyruqlari
src-tauri/icons/icon.svg# ikonka manbasi (o'lchamlar: npx tauri icon)
```

## Texnik eslatmalar

- xterm.js fon shaffofligini qo'llamaydi — matrix rejimida shaffoflik CSS
  (`body.matrix`) va `#shade` pardasi orqali; WebGL renderer bu rejimda
  o'chiriladi (matrix o'chiq bo'lsa avtomatik qaytadi).
- Clipboard webview'da ishlamaydi — `tauri-plugin-clipboard-manager` ishlatiladi.

## Litsenziya

[MIT](LICENSE)
