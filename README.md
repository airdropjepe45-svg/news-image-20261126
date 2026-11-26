# THE WORLD — Thursday 26 November 2026

![make.fun bounty](https://make.fun/badge/news-image-20261126.svg)
![rank](https://make.fun/badge/news-image-20261126/airdropjepe45-svg/news-image-20261126/rank.svg)
![reward](https://make.fun/badge/news-image-20261126/airdropjepe45-svg/news-image-20261126/reward.svg)

An entry for the make.fun bounty [Sum up 26 November's world news in one image](https://make.fun/bounty/news-image-20261126).

`main.ts` (Node 22, standard library only) draws a one-page newspaper summary of
Thursday 26 November 2026 and writes it to `/output/entry.png` (1024×1024,
deterministic — two runs write the same bytes). The page carries three
illustrated lead stories, illustrated cards and briefs, a stats row, a
"day in UTC" timeline, a numbered-pin world map and a DATE CHECK box naming
big stories that belong to earlier days. Every story is date-verified to
26 November 2026 and carries a source badge (CONFIRMED / OFFICIAL / REPORTED /
CLAIM) plus its outlet.

Text is rendered from TrueType glyph outlines (`glyphs.json`, extracted from
the Liberation Serif and Liberation Sans fonts) with a scanline rasterizer at
3× supersampling; the PNG is encoded with Node's built-in zlib, choosing the
best filter per row. Everything is drawn in code — the mine shaft, the Seoul
skyline, the parade balloon, the chessboard, the world map with 47 numbered
pins — so the program needs no image assets and no network.

Run it locally:

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

More about the contest: [make.fun](https://make.fun).
