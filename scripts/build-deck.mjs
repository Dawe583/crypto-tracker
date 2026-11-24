import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';

const output = new URL('../public/deck/', import.meta.url);
await mkdir(output, { recursive: true });
for (const name of ['app.js', 'style.css', 'space-grotesk-latin.woff2', 'OFL-SpaceGrotesk.txt']) {
  await copyFile(new URL(`../deck/${name}`, import.meta.url), new URL(name, output));
}
const html = await readFile(new URL('../deck/index.html', import.meta.url), 'utf8');
await writeFile(new URL('index.html', output), html.replace('</head>', '<script>window.DECK_DEMO_FALLBACK = true;</script>\n</head>'));
