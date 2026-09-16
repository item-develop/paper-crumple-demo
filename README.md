# Paper Crumple — Houdini VAT × Three.js

An interactive demo of crumpled paper balls: click one to unfold it into a card, drag to pick it up, flick to throw it. The crumpling animation is a Vellum simulation baked in Houdini as **VAT (Vertex Animation Textures)**, decoded and played back in Three.js, with cannon-es handling the physics.

- **Live demo:** https://paper-crumple-demo.pages.dev/
- Made for the Codrops article *Building an Interactive Crumpled Paper Effect with Houdini VAT and Three.js*

## Running it

No install and no build step — everything here is plain static files. Dependencies (three.js and cannon-es) are resolved from a CDN via the import map in `index.html`.

Serve this folder with any static file server and open it in a browser:

```sh
npx serve .
# or
python3 -m http.server 8000
```

(Opening `index.html` directly from the file system won't work — browsers block ES module and asset loading over `file://`.)

## What's inside

```
index.html      Entry point (import map + markup)
src/            The demo source, as-is
  main-vat.js   Scene, physics, interaction, state machine
  paper-vat.js  VAT loader: FBX + EXR decoding, smooth normals
  paper.js      Paper-face design composed with Canvas 2D
vat/            Houdini VAT export (FBX mesh + EXR position texture)
data/           Thumbnail SVGs for the fictional paper designs
```

## License

[MIT](./LICENSE)
