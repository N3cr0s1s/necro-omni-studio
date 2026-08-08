# Interface kontraktusok (v0.2)

Az alkalmazás nem ismer modellt, node class-t, graphot vagy effektet. Minden képesség manifesten keresztül regisztrálódik. Ez a dokumentum a kontraktusok gyűjteménye.

---

## 1. Generátor keretrendszer

### 1.1 Asset típusok

`video` · `audio` · `image` · `mask` · `text`

Minden típushoz tartozik egy importer, amely a generátor kimenetét a projektbe hozza:

| típus   | importer teendői                                             |
| ------- | ------------------------------------------------------------ |
| `video` | proxy, filmstrip, audio stream leválasztása, klip létrehozás |
| `audio` | waveform peak fájl, klip létrehozás                          |
| `image` | thumbnail, still klip vagy asset                             |
| `mask`  | RLE vagy PNG sequence a `masks/` alá                         |
| `text`  | markdown a `notes/` alá vagy szövegklip                      |

### 1.2 Capability descriptor

A manifest nem típusát deklarálja, hanem a be- és kimenetét. A UI ebből vezeti le, hol jelenik meg az akció.

```json
{
  "produces": "audio",
  "consumes": [],
  "surfaces": ["media_browser", "audio_track_empty"]
}
```

Leképezés:

| consumes                       | produces | UI hely                                            |
| ------------------------------ | -------- | -------------------------------------------------- |
| `[]`                           | `video`  | media browser, üres videósáv                       |
| `[]`                           | `audio`  | media browser, üres audiosáv                       |
| `[]`                           | `image`  | media browser                                      |
| `["image"]` role `first_frame` | `video`  | frame jobbklikk → „generálj innen"                 |
| `["video"]`                    | `video`  | videóklip jobbklikk → feldolgozás                  |
| `["video","mask"]`             | `video`  | maszkolt klip jobbklikk                            |
| `["audio"]`                    | `audio`  | audioklip jobbklikk                                |
| `["video"]`                    | `audio`  | videóklip → hang generálás                         |
| `["audio"]`                    | `text`   | audioklip → átirat                                 |
| `["text"]` role `script`       | `audio`  | media browser, üres audiosáv, szövegklip jobbklikk |

Az utolsó négy sor nincs implementálva. A `text` → `audio` (TTS) manifest kontraktusa megvan, a graph még nincs bekötve — lásd 2.3.

### 1.3 Registry

Indításkor beolvasásra kerül a projekt `generators/` mappája és a globális könyvtár. Minden manifest validálódik:

1. Minden `bind` pointer feloldódik-e a graphban?
2. Minden `requires` node class telepítve van-e a cél backenden (`/object_info`)?
3. Minden `outputs` node létezik-e?

Bukás esetén a generátor a registrybe kerül `unavailable` státusszal és konkrét hibaokkal. A UI szürkén megjeleníti — nem tűnik el csendben, mert a „hol van az eszközöm" hibakeresés így órákat visz el.

### 1.4 Backend interfész

```
submit(graph, assets)   → job_id
progress(job_id)        → stream: {percent, stage, preview?}
collect(job_id)         → [{type, path}]
cancel(job_id)
capabilities()          → telepített node class-ok, modellek, enum opciók
```

V1-ben egy implementáció: `comfyui`. A manifest `backend` mezője választ. Más backend hozzáadása nem érinti a manifesteket és a UI-t.

### 1.5 Job model és variánsok

Egy queue minden generátor típusra. Két szint:

**Group** — egy felhasználói kérés. Rekord: `group_id`, `generator_id`, `preset_id`, `params`, `variant_count`, `target` (timeline pozíció vagy media browser), `status`.

**Run** — egy variáns. Rekord: `run_id`, `group_id`, `seed`, `status`, `progress`, `outputs`, `error`.

A variánsok a `seed` paraméter változtatásával készülnek. Két végrehajtási mód:

| mód        | feltétel                            | viselkedés                                     |
| ---------- | ----------------------------------- | ---------------------------------------------- |
| sequential | default                             | N egymás utáni run, mindegyik saját seeddel    |
| batched    | a manifest deklarál `batch` blokkot | egy submit, a batch méret patchelve, N kimenet |

A batched mód gyorsabb (a modell egyszer töltődik be), de a VRAM a batch mérettel skálázódik, és a graphnak támogatnia kell. Ezért nem default: a sequential bármilyen graphon működik, és run-onként megszakítható.

**Kényszerek:**

- Ha a manifestnek nincs `seed` típusú paramétere, `variant_count` 1-re kényszerül. Indoklás megjelenik a UI-ban, nem néma azonos eredmények.
- Ha a felhasználó lezárta a seedet, ugyanez.
- A `batch.max` felett a runner sequential módra esik vissza, vagy felosztja (pl. 6 variáns, `batch.max: 3` → két batched run).

**UI viselkedés:** a placeholder megjelenik a cél pozíción, és a kész variánsok között váltani lehet helyben, a szerkesztés kontextusában. A részeredmények azonnal használhatók. Megerősítés véglegesít; az el nem fogadott variánsok a `generated/` mappában maradnak.

---

## 2. Generátor manifest

### 2.1 Példa — audio (a csatolt Stable Audio 3 graph)

```json
{
  "id": "stable_audio_3",
  "name": "Stable Audio 3",
  "backend": "comfyui",
  "graph": "audio_stable_audio_3_medium_base.json",

  "produces": "audio",
  "consumes": [],
  "surfaces": ["media_browser", "audio_track_empty"],

  "default_variants": 3,
  "batch": { "bind": "/52:11/inputs/batch_size", "max": 4 },

  "requires": [
    "CheckpointLoaderSimple",
    "EmptyLatentAudio",
    "CustomCombo",
    "JsonExtractString",
    "TextGenerate",
    "ComfySwitchNode",
    "SaveAudioAdvanced"
  ],

  "outputs": [{ "key": "audio", "type": "audio", "node": "57" }],

  "params": [
    {
      "key": "description",
      "label": "Leírás",
      "type": "text",
      "multiline": true,
      "bind": "/52:31/inputs/value"
    },

    {
      "key": "category",
      "label": "Kategória",
      "type": "enum",
      "options": ["Music", "Instrument", "SFX", "One-shot"],
      "default": "Music",
      "bind": "/52:43/inputs/choice"
    },

    {
      "key": "duration_s",
      "label": "Hossz (s)",
      "type": "float",
      "min": 1,
      "step": 1,
      "default": 50,
      "bind": "/52:36/inputs/value"
    },

    {
      "key": "enhance_prompt",
      "label": "Prompt bővítés LLM-mel",
      "type": "bool",
      "default": false,
      "bind": "/52:35/inputs/value"
    },

    {
      "key": "negative",
      "label": "Negatív prompt",
      "type": "text",
      "default": "",
      "bind": "/52:7/inputs/text"
    },

    { "key": "seed", "type": "seed", "bind": "/52:3/inputs/seed" },
    { "key": "steps", "type": "int", "min": 1, "max": 100, "default": 50, "bind": "/52:3/inputs/steps" },
    {
      "key": "cfg",
      "type": "float",
      "min": 1,
      "max": 15,
      "step": 0.5,
      "default": 7,
      "bind": "/52:3/inputs/cfg"
    }
  ],

  "presets": [
    { "id": "music", "name": "Zene", "pin": { "category": "Music" } },
    { "id": "instrumental", "name": "Instrumentális", "pin": { "category": "Instrument" } },
    { "id": "sfx", "name": "SFX", "pin": { "category": "SFX", "duration_s": 5 } },
    { "id": "oneshot", "name": "One-shot", "pin": { "category": "One-shot", "duration_s": 2 } }
  ]
}
```

Megjegyzések ehhez a graphhoz:

- A `duration_s` (`52:36`) a graphon belül két helyre megy: `EmptyLatentAudio.seconds` és a prompt template `AUDIO_LENGTH` behelyettesítése. Ezért egy pointer elég, nem kell `also`.
- A `max` értéket a modell tényleges hossz-plafonjához kell állítani, ez manifest-szintű döntés.
- A `category` a beágyazott system prompt JSON kulcsa, ezért csak a négy pontos string érvényes. Elgépelés esetén a graph futásidőben bukik, nem betöltéskor — érdemes a manifest validációt kiterjeszteni a `JsonExtractString` kulcskészletének ellenőrzésére.
- A `enhance_prompt` bekapcsolása LLM-et futtat a backenden. VRAM-ot fogyaszt, a GPU lock alá tartozik.
- A `default_variants: 3` mellé `batch` is deklarálva van, mert az `EmptyLatentAudio.batch_size` létezik. A runner így egy submitban kéri le a három jelöltet. Ha a `batch` blokkot kihagynád, ugyanaz az eredmény jönne ki három egymás utáni futásból, csak lassabban.
- A kimenet `SaveAudioAdvanced` (`57`), `format: "flac"`. A `format` inputot szándékosan nem exponáljuk paraméterként: a timeline-ra kerülő audio mindig veszteségmentes legyen, a kódolás az exportnál egyszer történik. Graph-literalként hagyva.

### 2.2 Példa — videó, kezdőkockából

Csak a lényegi rész:

```json
{
  "id": "minimax_h3_i2v",
  "produces": "video",
  "consumes": [{ "type": "image", "role": "first_frame" }],
  "surfaces": ["frame_context_menu"],

  "default_variants": 1,
  "params": [
    {
      "key": "first_frame",
      "label": "Kezdőkocka",
      "type": "image",
      "required": true,
      "bind": "/114/inputs/image",
      "transport": "upload_image"
    },
    { "key": "prompt", "type": "text", "multiline": true, "bind": "/105:104/inputs/prompt" },
    {
      "key": "duration_s",
      "type": "float",
      "min": 0.5,
      "max": 30,
      "default": 15,
      "bind": "/105:111/inputs/value"
    },
    { "key": "seed", "type": "seed", "bind": "/105:15/inputs/noise_seed" },
    {
      "key": "fps",
      "type": "int",
      "default": 24,
      "bind": "/105:91/inputs/fps",
      "also": [
        {
          "pointer": "/105:107/inputs/expression",
          "template": "max(5, round(a * {fps})) + (5 - (max(5, round(a * {fps})) % 17)) % 17"
        }
      ]
    }
  ]
}
```

Itt nincs `batch` blokk, és a `default_variants` 1. Videónál a batch a VRAM-ot azonnal elvinné, és három jelölt legenerálása amúgy is percekben mérhető — a felhasználó döntse el futásonként, ha többet akar.

Az `fps` mutatja, miért nem elég az egy-pointeres kötés: a hossz-számítás expression stringjében is benne van a szorzó. Az `also` fanoutolja az értéket, a `template` string-interpolációval patchel.

A `consumes` `role: "first_frame"` az, ami engedélyezi a frame context menüben az akciót. A t2v és i2v változat ugyanazt a node class-t használja — ezért nem lehet a képességet a graphból kitalálni, deklarálni kell.

### 2.3 Példa — TTS (kontraktus, graph még nincs)

A manifest megírható a graph előtt. A `graph: null` és a `bind: null` pointerek miatt a registry `unbound` státusszal veszi fel, a UI szürkén mutatja „graph nincs bekötve" indoklással. Amikor a graph elkészül, az inspector kitölti a pointereket — a kontraktus többi része nem változik.

```json
{
  "id": "tts",
  "name": "Text to speech",
  "backend": "comfyui",
  "graph": null,
  "status": "unbound",

  "produces": "audio",
  "consumes": [
    { "type": "text", "role": "script", "required": true, "sources": ["inline", "notes_file", "text_clip"] },
    { "type": "audio", "role": "voice_reference", "required": false }
  ],
  "surfaces": ["media_browser", "audio_track_empty", "text_clip_context_menu"],

  "duration": "discovered",
  "default_variants": 1,

  "outputs": [
    { "key": "audio", "type": "audio", "node": null },
    { "key": "alignment", "type": "text", "node": null, "format": "word_timings", "optional": true }
  ],

  "params": [
    { "key": "script", "label": "Szöveg", "type": "text", "multiline": true, "bind": null },
    { "key": "voice", "label": "Hang", "type": "enum", "bind": null, "options": { "from": "capabilities" } },
    {
      "key": "voice_reference",
      "label": "Hangminta",
      "type": "audio",
      "required": false,
      "bind": null,
      "transport": "upload_audio"
    },
    { "key": "language", "type": "enum", "options": ["hu", "en"], "default": "hu", "bind": null },
    { "key": "speed", "type": "float", "min": 0.5, "max": 2, "step": 0.05, "default": 1, "bind": null },
    { "key": "seed", "type": "seed", "bind": null }
  ]
}
```

**Szöveg forrásai** (`sources`) — a `script` input három helyről kaphat tartalmat:

| source       | jelentés                                             |
| ------------ | ---------------------------------------------------- |
| `inline`     | a panelen beírt szöveg                               |
| `notes_file` | markdown vagy txt fájl a projekt `notes/` mappájából |
| `text_clip`  | egy timeline-on lévő szövegklip tartalma             |

A `text_clip` az érdekes: a képernyőn már megjelenített szövegből generálsz narrációt, ezért van a `surfaces` között a `text_clip_context_menu`.

**Hang választása** — vagy `voice` enum (a backend által ismert hangok, `capabilities()` alapján), vagy `voice_reference` audio asset (voice cloning). A kettő közül egyet kell megadni; a manifest validáció ezt `required: false` párként kezeli, a UI pedig egymást kizáró választóként mutatja.

**Alignment kimenet** — ha a motor tud szószintű időbélyeget, a `word_timings` formátum:

```json
{
  "words": [
    { "text": "Egy", "start": 0.0, "end": 0.28 },
    { "text": "rendszer", "start": 0.28, "end": 0.81 }
  ]
}
```

Ebből később automatikusan szinkronban lévő szövegklipek generálhatók. Opcionális kimenet: ha a graph nem adja, a generátor működik nélküle.

**Chunkolás** — hosszú szkriptnél a mondatonkénti generálás jellemzően jobb minőséget ad, és mondatonként újrapróbálható. Ez nem variáns (nem alternatívák, hanem egymás után fűzendő részek), ezért külön mód lenne. V1-ben nincs; ha kell, `chunking: "sentence"` deklarációként kerül a manifestbe, és a runner a részeket összefűzi az importer előtt.

### 2.4 Hossz: declared vagy discovered

Minden manifest deklarálja, honnan derül ki a kimenet hossza:

| érték        | jelentés                   | placeholder       | példa                    |
| ------------ | -------------------------- | ----------------- | ------------------------ |
| `declared`   | paraméter határozza meg    | előre méretezett  | videó és audio generálás |
| `discovered` | csak a kimenetből derül ki | ismeretlen hosszú | TTS, stem szeparálás     |

`discovered` esetén a beszúrás szabálya: a klip a cél sávra kerül a playhead pozíciótól, a későbbi klipek **nem** csúsznak el. Ha ütközik egy meglévő klippel, a következő szabad audiosávra kerül, szükség esetén új sáv jön létre. Egy narráció ne rendezze át a videóvágást.

### 2.5 Paraméter típusok

| type                              | UI kontroll                                     | patch érték         |
| --------------------------------- | ----------------------------------------------- | ------------------- |
| `text`                            | egy- vagy többsoros input                       | string              |
| `int`, `float`                    | slider + numerikus input                        | szám                |
| `bool`                            | switch                                          | bool                |
| `enum`                            | dropdown (statikus lista vagy `capabilities()`) | string              |
| `seed`                            | szám + randomize/lock                           | int                 |
| `image`, `video`, `audio`, `mask` | asset picker vagy timeline-forrás               | feltöltött filename |

Az `enum` `options: { "from": "capabilities", "node_class": "...", "input": "..." }` formában élő listát kap a backendről — a modell- és sampler-listák így mindig a valós állapotot tükrözik.

### 2.6 Preset szemantika

A preset lefixál paramétereket, és külön UI-belépőt kap. A lefixált paraméterek nem jelennek meg a panelen. Egy graph így több eszközként viselkedik, kódduplikáció nélkül. A registry a presetet önálló elemként indexeli, a job pedig eltárolja a `preset_id`-t is a reprodukálhatóság kedvéért.

---

## 3. ComfyUI backend

A runner nem tud semmit a node-okról. Csak graph patchelés és endpoint hívás.

```
POST /prompt                 { prompt: patchelt_graph, client_id }  → prompt_id
WS   /ws?clientId=...        progress, executing, executed események
GET  /history/{prompt_id}    kimeneti fájlnevek
GET  /view?filename=&subfolder=&type=output   letöltés
POST /upload/image           input asset feltöltés
GET  /object_info            capabilities(): node class-ok, modellek, enum opciók
```

Sorrend: asset feltöltések → graph patchelés (bind + also + preset pin) → submit → websocket progress → history → letöltés a `generated/` mappába → típus szerinti importer → a pending placeholder lecserélése.

Ha egy videó kimenet audio streamet is tartalmaz, az importer leválasztja, és a videóklip alá linkelt audioklipet tesz.

---

## 4. Effekt manifest

Effekt = GLSL fragment shader + manifest, az `effects/` mappában. A compositor betöltéskor kompilál és cache-eli a programot.

### 4.1 Effekt

```json
{
  "id": "film_grain",
  "name": "Film grain",
  "category": "effect",
  "shader": "film_grain.frag",
  "samplers": ["source"],
  "params": [
    {
      "key": "amount",
      "uniform": "u_amount",
      "type": "float",
      "min": 0,
      "max": 1,
      "default": 0.15,
      "keyframable": true
    },
    {
      "key": "size",
      "uniform": "u_size",
      "type": "float",
      "min": 0.5,
      "max": 4,
      "default": 1,
      "keyframable": true
    }
  ]
}
```

### 4.2 Átmenet

```json
{
  "id": "crosswarp",
  "category": "transition",
  "shader": "crosswarp.frag",
  "convention": "gl-transitions",
  "samplers": ["from", "to"],
  "progress_uniform": "progress",
  "params": [
    {
      "key": "strength",
      "uniform": "strength",
      "type": "float",
      "min": 0,
      "max": 1,
      "default": 0.4,
      "keyframable": false
    }
  ]
}
```

A `convention: "gl-transitions"` esetén a compositor a szabvány wrappert generálja (`getFromColor`, `getToColor`, `transition(vec2 uv)`), tehát a gl-transitions könyvtár shaderei módosítás nélkül bemásolhatók.

### 4.3 Maszkolt effekt

```json
{
  "id": "background_blur",
  "category": "effect",
  "samplers": ["source", "mask"],
  "params": [
    {
      "key": "radius",
      "uniform": "u_radius",
      "type": "float",
      "min": 0,
      "max": 40,
      "default": 12,
      "keyframable": true
    },
    { "key": "invert", "uniform": "u_invert", "type": "bool", "default": false }
  ]
}
```

A `mask` sampler slot deklarálása az egyetlen kapcsolat a SAM 2 és az effekt rendszer között. A maszk-track a klip inspectorban bekötődik ide; a compositor a cache-elt maszkot textúraként adja át. Nincs SAM-specifikus effekt kód.

### 4.4 Beépített uniformok

Mindig elérhetők, nem kell deklarálni:

```glsl
uniform vec2  u_resolution;   // kimeneti felbontás pixelben
uniform float u_time;         // timeline idő másodpercben
uniform float u_clip_time;    // klip-relatív idő másodpercben
uniform float u_clip_length;  // klip hossza másodpercben
```

### 4.5 Keyframe modell

Minden `keyframable: true` paraméter értéke vagy skalár, vagy keyframe lista:

```json
{
  "keyframes": [
    { "t": 0, "v": 0, "ease": "linear" },
    { "t": 1.5, "v": 0.8, "ease": "ease-in-out" }
  ]
}
```

A `t` klip-relatív másodperc. Interpoláció v1-ben: `linear`, `ease-in`, `ease-out`, `ease-in-out`, `hold`. Bezier görbeszerkesztő v2.

Az átmenetek `progress` uniformja nem keyframe — az engine számolja a klipek átfedéséből.

A kiértékelés frame-enként, közvetlenül a uniform beállítás előtt történik, ugyanazzal a kóddal previewban és exportban.

### 4.6 Hibakezelés

Shader compile hiba esetén az effekt passthrough módba esik, a klip inspectorban megjelenik a compiler hibaüzenete sorszámmal. A render nem áll meg, és az export sem hiúsul meg egy törött effekt miatt.

---

## 5. Szövegréteg és animáció

A szövegklip nem shader-effekt, hanem saját réteg-típus, de a paraméterei ugyanúgy keyframe-elhetők, és shader effektek rakhatók rá.

### 5.1 Szövegklip paraméterek

| paraméter                       | típus                   | keyframe |
| ------------------------------- | ----------------------- | -------- |
| `content`                       | text                    | nem      |
| `font`, `size`, `weight`        | enum / int              | nem      |
| `color`, `outline`, `shadow`    | color / objektum        | nem      |
| `x`, `y`                        | float (0–1 normalizált) | igen     |
| `scale`, `rotation`, `opacity`  | float                   | igen     |
| `letter_spacing`, `line_height` | float                   | igen     |

### 5.2 Animáció presetek

Preset = előre definiált keyframe-generátor. Beállításnál a rendszer legenerálja a megfelelő keyframe-eket, amiket a felhasználó utána szabadon módosíthat. Nincs rejtett, nem szerkeszthető animáció.

```json
{
  "in": { "preset": "slide", "direction": "up", "duration": 0.4, "ease": "ease-out" },
  "out": { "preset": "fade", "duration": 0.3, "ease": "linear" }
}
```

Presetek: `fade`, `slide` (`up` / `down` / `left` / `right`), `scale`, `typewriter`, `none`.

### 5.3 Typewriter — külön mechanizmus

A typewriter nem transform-keyframe, mert a látható karakterek száma változik. Megvalósítás:

1. A teljes szöveg egyszer rasterizálódik Canvas 2D-vel egy textúrába.
2. Mellé eltárolódik a karakterek kumulatív x-előretolás listája.
3. Renderkor a látható karakterszám idő alapján számolódik, a quad pedig a megfelelő x pozícióig vágódik.

Így frame-enként nincs újrarasterizálás, a textúra cache-elt. Több sor esetén sorért egy quad, a vágás a soron belüli aktív karakterig tart.

### 5.4 Rasterizálás és cache

A szövegtextúra cache kulcsa a nem-keyframe-elhető paraméterek hash-e (`content`, `font`, `size`, `weight`, `color`, `outline`, `shadow`). A keyframe-elhető paraméterek (`x`, `y`, `scale`, `rotation`, `opacity`) transformként érvényesülnek, nem érintik a textúrát — így egy animált szöveg a teljes klip alatt egyetlen rasterizálást igényel.
