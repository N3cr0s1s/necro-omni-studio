# Videószerkesztő — nagyvonalú specifikáció (v0.4)

## 1. Termék

Lokális desktop videószerkesztő, amelyben a generatív tartalom-előállítás, az objektum-szegmentálás és a shader-alapú effektek elsőosztályú timeline-műveletek. Az alkalmazás **semmilyen konkrét modellt, workflow-t, generátort vagy effektet nem ismer** — mindegyik deklaratív manifesten keresztül csatlakozik egy generátor keretrendszerhez.

## 2. Célcsoport és nem-célok

**Cél:** egyedül dolgozó kreatív, saját GPU-val, rövid (< 3 perc) tartalomhoz.
**Nem cél:** kollaboráció, cloud render, több GPU, színkezelés (LUT/ACES pipeline), 4K realtime, mobil.

## 3. Platform

Windows és Linux (NVIDIA GPU), macOS később. Electron shell + React/TS frontend + Python (FastAPI) sidecar. A backend endpointok konfigurálhatók.

## 4. Projekt = mappa

Egy projekt egy fájlrendszeri mappa, nem adatbázis. A mappa zippelése = teljes projekt átvitele.

```
MyProject/
  project.json      timeline dokumentum
  media/            importált forrásfájlok
  generated/        generátor kimenetek (videó, audio, kép)
  masks/            SAM 2 maszk cache
  effects/          projekt-lokális shaderek + manifestek
  generators/       graph JSON-ök + generátor manifestek
  notes/            szabad tartalom: markdown, referenciák, bármi
  renders/          exportok
  cache/            proxy, filmstrip, waveform — származtatott, törölhető
```

A media browser a valódi mappafát mutatja, file watcherrel. Tetszőleges alkönyvtár és fájltípus megengedett; a markdownt a browser megjeleníti. Drag & drop a browserből a timeline-ra.

**Asset identitás:** projekt-relatív útvonal. A cache kulcs content hash.

## 5. Generátor keretrendszer

Minden generatív képesség — videó, audio, kép, upscale, átirat, bármi későbbi — ugyanazon a kereten keresztül csatlakozik. Ez a spec legfontosabb architekturális eleme.

**5.1 Asset típusok** — `video`, `audio`, `image`, `mask`, `text`. Minden típushoz tartozik egy importer, ami tudja, hogyan kerül a kimenet a projektbe (videónál proxy és filmstrip, audiónál waveform peak, stb).

**5.2 Capability descriptor** — a manifest nem azt deklarálja, hogy „ez egy videó generátor", hanem hogy mit fogyaszt és mit termel (`consumes` / `produces`). A UI ebből vezeti le, hol jelenjen meg az akció. Új képesség hozzáadása manifest, nem kód. Így fedi le ugyanaz a keret a videó generálást, az audio generálást, a text to speechet, a képgenerálást, az upscale-t és bármit, ami később jön.

**5.3 Hossz: declared vagy discovered** — a legtöbb generátornál a kimenet hossza paraméter (`declared`). A TTS-nél és a hasonlóknál csak a kimenetből derül ki (`discovered`), ezért a placeholder nem méretezhető előre. `discovered` esetén a klip a playhead pozíciótól a cél sávra kerül, a későbbi klipek nem csúsznak el; ütközésnél a következő szabad audiosávra megy. Egy narráció ne rendezze át a videóvágást.

**5.4 Preset** — egy manifest több UI-belépőt deklarálhat, amelyek ugyanazt a graphot használják bizonyos paraméterekre lefixálva. Egy audio graph így külön „zene", „SFX" és „one-shot" eszközként jelenik meg.

**5.5 Backend absztrakció** — a `backend` mező választja ki a futtatót. Első és egyetlen implementáció v1-ben: `comfyui`. A runner interfész (`submit` / `progress` / `collect`) mögé később más backend is beköthető anélkül, hogy a manifestek vagy a UI változna.

**5.6 Registry és validáció** — indításkor a rendszer beolvassa a projekt `generators/` mappáját és a globális könyvtárat, validálja a manifesteket (pointerek feloldódnak, `requires` node class-ok telepítve a cél backenden), és felépíti a registryt. A UI menük ebből generálódnak. A nem futtatható generátorok szürkén, konkrét hibaokkal jelennek meg — nem tűnnek el csendben.

**5.7 Egységes job model** — egy job queue minden generátor típusra. A job: generátor id, paraméterek, státusz, progress, kimenetek, hiba. A timeline-on típus-megfelelő pending placeholder jelenik meg (videóklip, audioklip), de a job gépezet közös.

**5.8 Variáns generálás** — a generátorok több jelöltet állítanak elő, amelyek közül a felhasználó választ. A darabszám a manifestben deklarált default (audiónál 3, videónál 1), futásonként felülírható, és a beállításokban van globális felülbírálás. A variánsok a `seed` paraméter változtatásával jönnek létre; ha a manifestben nincs `seed` típusú paraméter, vagy a felhasználó lezárta a seedet, a darabszám 1-re kényszerül konkrét indoklással. Ha a manifest deklarál batch képességet, a runner egy submitban kéri le a variánsokat, egyébként N egymás utáni jobot indít — így minden graph működik batch támogatás nélkül is.

A választás a timeline-on történik, helyben: a placeholder megjelenik a cél pozíción, a kész variánsok között váltani lehet, és a szerkesztés kontextusában hallgatható vagy megtekinthető, majd megerősítéssel véglegesíthető. Ez szándékosan nem modális választó — egy zenei alap vagy egy vágókép csak a környezetében értékelhető. A részeredmények azonnal használhatók, nem kell megvárni mind az N elkészülését. Az el nem fogadott variánsok a `generated/` mappában maradnak.

**5.9 Manifest inspector** — a manifestet nem kézzel írjuk. Az inspector betölti a graph JSON-t, felsorolja a node-okat és literal inputjaikat, a felhasználó kipipálja, mi legyen paraméter, megadja a típust és a range-et, majd az inspector kiírja a manifestet. Kódírás nincs.

## 6. Szerkesztő funkciók

**6.1 Timeline** — típusos sávok: N videó, N audio, N szöveg. Frame-pontos vágás, trim, csúsztatás, ripple delete, snap. Zoom, playhead, in/out marker. A klip kinyitható: alatta megjelennek az effekt paraméter-sávok keyframe jelölőkkel. Undo/redo mindenre.

**6.2 Preview** — realtime 1080p/30 proxyból, WebCodecs + WebGL2. Audio mix és scrub, waveform.

**6.3 Effektek és átmenetek** — GLSL fragment shader + manifest. Klipenként rendezett effekt-stack, a sorrend drag & droppal átrendezhető. Minden effekt egy render pass, a kimenete a következő bemenete (ping-pong FBO pár). Bármely numerikus paraméter keyframe-elhető. Átmenet a klipek átfedéséből: a `progress` 0→1 értéket az engine számolja. A gl-transitions konvenció támogatott.

**6.4 Keyframe rendszer** — a klip kinyitásával paraméterenként egy sáv a timeline-on. A jelölők vízszintesen húzhatók, az érték számmezőben szerkeszthető. Interpoláció jelölőnként: `linear`, `ease-in`, `ease-out`, `ease-in-out`, `hold`. Bezier görbeszerkesztő v2. Egy húzás egy undo lépés.

**6.5 Szöveg és szöveganimáció** — szövegklip: font, méret, szín, pozíció, kontúr, árnyék. Animáció presetek (fade, slide, scale, typewriter) be- és kimenetre külön, hossz és irány paraméterrel. A preset keyframe-eket generál, amelyek utólag szerkeszthetők — nincs rejtett animáció. A typewriter külön mechanizmus: egyszeri rasterizálás + karakter-előretolás lista + quad vágás.

**6.6 Szegmentálás (SAM 2)** — objektum kijelölése egy frame-en, maszk propagálás a klip range-én, cache a `masks/` alatt. A maszk nem speciális eset: bármely effekt deklarálhat `mask` sampler slotot.

**6.7 Export** — H.264/H.265 mp4. Ugyanaz a WebGL2 compositor renderel offscreen, a frame-ek ffmpeg pipe-ra mennek. WYSIWYG garancia, mert az effektek és a keyframe kiértékelés is ugyanaz.

## 7. Kötelező technikai döntések

- Minden időérték frame-index egész számként, projekt fps-en. Vegyes fps-hez rational time.
- Egyetlen compositor implementáció previewra és exportra.
- Paraméter érték = skalár vagy keyframe lista, frame-enként kiértékelve a uniform beállítás előtt.
- Keyframe vagy klip húzása egyetlen undo lépés (patch coalescing).
- Semmilyen konkrét generátor, modell, node class vagy effekt nem szerepel a kódban.
- A UI menüstruktúra a registryből generálódik, nem hardcode-olt lista.
- **GPU lock:** három fogyasztó verseng a VRAM-ért — generátor backend, SAM 2 worker, és a generátor graphokba épített LLM-ek (prompt bővítés). Egy központi szemafor, sorosítva.
- Manifest betöltésnél minden pointer validálva; hiba esetén a törött pointer nevesítve.

## 8. Nem-funkcionális

Timeline válaszidő < 16 ms. Használható 200 klipig / 20 perc forrásanyagig. Effekt-stack figyelmeztetés 8 pass felett. Autosave 30 s, crash recovery. Offline működés a generálás kivételével.

## 9. Mérföldkövek

| #   | Tartalom                                                           |
| --- | ------------------------------------------------------------------ |
| M1  | Dokumentummodell, időmatek, projekt mappa, unit tesztek            |
| M2  | Media browser, import, proxy, filmstrip, waveform, file watcher    |
| M3  | Timeline szerkesztés + egysávos preview                            |
| M4  | Multi-track compositor, audio                                      |
| M5  | Effekt/átmenet engine, effekt-stack UI drag & droppal              |
| M6  | Keyframe rendszer: paraméter-sávok, interpoláció, patch coalescing |
| M7  | Szövegréteg + animáció presetek                                    |
| M8  | ffmpeg export                                                      |
| M9  | Generátor keretrendszer: manifest, registry, job queue, inspector  |
| M10 | ComfyUI backend + az első generátorok (videó t2v/i2v, audio, TTS)  |
| M11 | SAM 2 maszk pipeline                                               |

Az M9 és M10 szándékosan külön van: a keretrendszer előbb készül el és tesztelhető mock backenddel, mint hogy bármelyik konkrét graph bekötésre kerül.

## 10. Meghozott döntések

- **Keyframe:** v1-ben igen, jelölőnkénti easinggel, a sáv a timeline-on a klip alatt. Bezier v2. Keyframe másolás klipek között nem cél v1-ben.
- **Szöveganimáció:** presetek keyframe-generátorként, nem fekete boxként.
- **Effekt-stack:** drag & droppal átrendezhető.
- **Shader hiba:** passthrough mód, a render és az export nem áll meg.
- **`generated/`:** nincs retention policy, kézi takarítás; a browser mutatja a mappa méretét.
- **Több GPU:** nem cél. **Konkrét modellek:** irrelevánsak, a manifest bármit elfogad.
- **Text to speech:** a manifest kontraktus kész (szöveg forrása lehet beírt szöveg, `notes/` fájl vagy timeline szövegklip; hang enum vagy hangminta; opcionális szószintű időbélyeg kimenet). A graph még nincs bekötve, a registry `unbound` státusszal veszi fel.
- **Variánsok:** manifest-szintű default (audio 3, videó 1), seed alapján, in-place választás a timeline-on. Batch csak ha a manifest deklarálja.
- **Audio kimeneti formátum:** veszteségmentes (flac) a generátor graphokból, nem MP3.

Nyitott architekturális kérdés nincs. A specifikáció implementálható.
