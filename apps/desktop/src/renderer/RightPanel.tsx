import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { type FrameIndex, type PresetId, clipId, locateClip, trackId } from '@nos/core';
import type { TimelineDocument } from '@nos/core';
import type { EffectRegistry } from '@nos/effects';
import type {
  GeneratorManifest,
  GeneratorRegistry,
  JobTarget,
  RegistryRecord,
  SelectionOutcome,
} from '@nos/generators';
import {
  type TextChoice,
  acceptSelection,
  buildSelection,
  exclusiveGroupsOf,
  previewOf,
  selectMember,
  unansweredGroups,
} from '@nos/generators';
import { bridge } from './bridge.js';
import { noteChoicesFrom, resolveTextChoice, textChoicesFrom } from './generator-text.js';
import type { MaskWorkspace } from './use-mask-workspace.js';
import type { DirectoryNode } from '@nos/media';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ClipboardPasteIcon,
  CpuIcon,
  EyeIcon,
  FileJsonIcon,
  PaletteIcon,
  RedoIcon,
  ScissorsIcon,
  SplitIcon,
  Trash2Icon,
  TriangleAlertIcon,
  TypeIcon,
  UndoIcon,
} from 'lucide-react';
import { GeneratorPanel, SegmentationPanel, VariantPicker } from '@nos/ui';
import type { RecalledRun } from '@nos/generators';
import type { ClipId } from '@nos/core';
import type { MaskChoice } from './ClipInspector.js';
import { Button } from '@nos/ui/components/ui/button';
import { Field, FieldLabel } from '@nos/ui/components/ui/field';
import { NativeSelect, NativeSelectOption } from '@nos/ui/components/ui/native-select';
import { Separator } from '@nos/ui/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@nos/ui/components/ui/tabs';
import { cn } from '@nos/ui/lib/utils';
import { assetChoicesFrom } from './generator-assets.js';
import { useFrameGrab } from './use-frame-grab.js';
import { ClipInspector } from './ClipInspector.js';
import { TextInspector } from './TextInspector.js';
import { ProjectSettings } from './ProjectSettings.js';
import { useAudition } from './use-audition.js';
import type { SidecarInfo } from '../main/ipc-contract.js';
import type { GeneratorRuntime } from './use-generator-runtime.js';
import type { LibraryProblem } from './use-generator-library.js';
import type { AppSettings } from '../main/app-settings.js';

/**
 * The right-hand panel.
 *
 * One column, four tools, chosen by a tab strip: the clip inspector, the generator panel, the variant
 * picker for whatever is currently staged, and segmentation. A tab strip rather than four stacked panels
 * because the mockups' inspector is 340 px wide and stacking them would push every control below the
 * fold on a laptop.
 *
 * Everything shown here is a rendering of a value the packages produce. The panel chooses *which*
 * value; it decides nothing about generators, masks or edits.
 */

export type PanelTab = 'inspector' | 'generate' | 'variants' | 'segment';

export interface RightPanelProps {
  readonly document: TimelineDocument;
  readonly effects: EffectRegistry;
  readonly onChangeDocument: (label: string, next: TimelineDocument) => void;
  readonly registry: GeneratorRegistry | undefined;
  /** The project folder, so a generator's asset inputs can be chosen from the files that exist. */
  readonly projectTree: DirectoryNode | undefined;
  /**
   * The mask session for the selected clip, and everything that acts on it.
   *
   * Held above this panel because the *points* are placed on the preview, which is its sibling — a
   * session owned here could not be drawn there, and two sessions would disagree the moment either
   * was edited.
   */
  readonly masks: MaskWorkspace;
  /** What an effect on the selected clip may bind its `mask` slot to. Empty until one is segmented. */
  readonly maskChoices?: readonly MaskChoice[] | undefined;
  /** Which panel is open, so the preview knows whether it is placing mask points. */
  /**
   * Which tab is open, and how to change it.
   *
   * **Controlled by the shell**, because the shell has reasons to switch it: renaming a clip from the
   * timeline's menu opens the inspector, recalling a generation opens the generate panel. It used to
   * own the tab and merely *report* changes upward, so the shell held a mirror it could write to with
   * no effect — both of those actions ran, said they had, and left the panel where it was.
   */
  readonly tab: PanelTab;
  readonly onTabChange: (tab: PanelTab) => void;
  /** Opens the manifest authoring screen — the spec's route to a new generator without code. */
  readonly onAuthorManifest: () => void;
  /** Lands an accepted variant on the timeline. Supplied by the shell, which owns the document. */
  readonly onAcceptVariant: (outcome: SelectionOutcome, manifest: GeneratorManifest) => void;
  readonly libraryProblems: readonly LibraryProblem[];
  /** Where the shared library lives, so the empty state can name a folder to drop a manifest into. */
  readonly libraryPath: string | undefined;
  readonly runtime: GeneratorRuntime;
  readonly playhead: FrameIndex;
  /** Where the sidecar serves project files, so a generated variant can be auditioned. */
  readonly sidecar: SidecarInfo | undefined;
  readonly selectedClip: string | undefined;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly onSplit: () => void;
  readonly onSplitAllTracks: () => void;
  /** Removes the selection. The Ripple toggle decides whether the gap closes. */
  readonly onRemoveClip: () => void;
  readonly onToggleClipEnabled: () => void;
  readonly onCopyAttributes: () => void;
  readonly onPasteAttributes: () => void;
  /** What was copied, so the paste control can say what it will apply. */
  readonly attributeSummary: string | undefined;
  /** What removal will do right now, so the button can say it rather than imply it. */
  readonly removeLabel: string;
  readonly removeHint: string;
  readonly onNudge: (delta: number) => void;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
  readonly onAddText: () => void;
  /** Reports an edit the document layer refused, so the shell can show its reason. */
  readonly onReject: (reason: string) => void;
  /**
   * Settings recalled from a generated file, to be loaded into the generate panel.
   *
   * Applied when the value changes rather than read every render, so the user can adjust what was
   * recalled without the panel snapping back to it. The caller mints a new object per recall.
   */
  readonly recalled?: RecalledRun | undefined;
  /** Renames a clip. Absent leaves its name read-only rather than offering a field that does nothing. */
  readonly onRenameClip?: ((clip: ClipId, name: string) => void) | undefined;
  /** Opens the clip's name field, for a rename asked for from the timeline's context menu. */
  readonly renamingClip?: boolean | undefined;
  /** Files in the project's `effects/` folder that could not be loaded at all. */
  readonly effectProblems?: readonly LibraryProblem[] | undefined;
  /** Settings that apply to every project on this machine, shown apart from the project's own. */
  readonly appSettings?: AppSettings | undefined;
  readonly onChangeAppSettings?: ((patch: Partial<AppSettings>) => void) | undefined;
}

export function RightPanel(props: RightPanelProps): ReactNode {
  const { tab, onTabChange } = props;

  return (
    <aside aria-label="Inspector" className="flex h-full min-h-0 min-w-0 flex-col">
      <Tabs
        value={tab}
        onValueChange={(next) => onTabChange(next as PanelTab)}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <div className="flex h-8.5 flex-none items-center px-2">
          <TabsList aria-label="Panel">
            {(['inspector', 'generate', 'variants', 'segment'] as const).map((entry) => (
              <TabsTrigger key={entry} value={entry} className="capitalize">
                {entry}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <Separator />

        <TabsContent value="inspector" className="min-h-0 flex-1 overflow-auto">
          <InspectorTab {...props} />
        </TabsContent>
        <TabsContent value="generate" className="min-h-0 flex-1 overflow-auto">
          <GenerateTab {...props} />
        </TabsContent>
        <TabsContent value="variants" className="min-h-0 flex-1 overflow-auto">
          <VariantsTab {...props} />
        </TabsContent>
        <TabsContent value="segment" className="min-h-0 flex-1 overflow-auto">
          <SegmentTab {...props} />
        </TabsContent>
      </Tabs>
    </aside>
  );
}

function InspectorTab({
  document,
  appSettings,
  onChangeAppSettings,
  effects,
  onChangeDocument,
  playhead,
  selectedClip,
  maskChoices,
  canUndo,
  canRedo,
  onSplit,
  onSplitAllTracks,
  onRemoveClip,
  onToggleClipEnabled,
  onCopyAttributes,
  onPasteAttributes,
  attributeSummary,
  removeLabel,
  removeHint,
  onNudge,
  onUndo,
  onRedo,
  onAddText,
  onReject,
  onRenameClip,
  renamingClip,
  effectProblems,
}: RightPanelProps): ReactNode {
  return (
    <div className="flex flex-col">
      {/* Text properties come first for a text clip: the effect stack applies to it too, but the words
          are what the user opened the inspector to change. */}
      <TextInspector
        document={document}
        {...(selectedClip !== undefined ? { clip: selectedClip } : {})}
        onChange={onChangeDocument}
      />

      <ClipInspector
        document={document}
        {...(selectedClip !== undefined ? { clip: selectedClip } : {})}
        effects={effects}
        playhead={playhead}
        onChange={onChangeDocument}
        onReject={onReject}
        {...(maskChoices !== undefined ? { masks: maskChoices } : {})}
        {...(onRenameClip !== undefined ? { onRename: onRenameClip } : {})}
        {...(effectProblems !== undefined ? { effectProblems } : {})}
        renaming={renamingClip}
      />

      <ProjectSettings
        document={document}
        onChange={onChangeDocument}
        onReject={onReject}
        {...(appSettings !== undefined ? { appSettings } : {})}
        {...(onChangeAppSettings !== undefined ? { onChangeAppSettings } : {})}
      />

      <div className="flex flex-col gap-2 p-4">
        <Button
          variant="outline"
          size="sm"
          onClick={onSplit}
          disabled={selectedClip === undefined}
          title="Split at the playhead (S)"
        >
          <SplitIcon />
          Split at playhead
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onSplitAllTracks}
          title="Cut every unlocked track at the playhead (Shift+S)"
        >
          <ScissorsIcon />
          Split all tracks
        </Button>
        <div className="flex gap-2">
          {/* Named for what it will do, not for the key that does it. Which of the two removals is
              about to happen is the Ripple toggle's state, and a button that said only "Delete"
              would leave the user to remember it. */}
          <Button
            variant="destructive"
            size="sm"
            onClick={onRemoveClip}
            disabled={selectedClip === undefined}
            title={removeHint}
            className="flex-1"
          >
            <Trash2Icon />
            {removeLabel}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onToggleClipEnabled}
            disabled={selectedClip === undefined}
            title="Take the clip out of the composite without removing it (E)"
            className="flex-1"
          >
            <EyeIcon />
            Enable / disable
          </Button>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onNudge(-1)}
            disabled={selectedClip === undefined}
            title="Nudge one frame left"
            className="flex-1"
          >
            <ChevronLeftIcon />
            1f
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onNudge(1)}
            disabled={selectedClip === undefined}
            title="Nudge one frame right"
            className="flex-1"
          >
            1f
            <ChevronRightIcon />
          </Button>
        </div>
        {/* Grading a scene clip by clip is how a grade drifts: the same eleven-step ritual, subtly
            different each time. */}
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onCopyAttributes}
            disabled={selectedClip === undefined}
            title="Copy this clip's effects, framing, speed and level (Ctrl+Shift+C)"
            className="flex-1"
          >
            <PaletteIcon />
            Copy look
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onPasteAttributes}
            disabled={selectedClip === undefined || attributeSummary === undefined}
            title={
              attributeSummary === undefined
                ? 'Copy a look first'
                : `Apply ${attributeSummary} to every selected clip (Ctrl+Shift+V)`
            }
            className="flex-1"
          >
            <ClipboardPasteIcon />
            Paste look
          </Button>
        </div>
        {attributeSummary !== undefined && (
          <p className="font-mono text-xs text-muted-foreground">{`clipboard: ${attributeSummary}`}</p>
        )}

        <Button
          variant="outline"
          size="sm"
          onClick={onAddText}
          title="Add a title at the playhead, on the text track"
        >
          <TypeIcon />
          Add title
        </Button>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onUndo} disabled={!canUndo} className="flex-1">
            <UndoIcon />
            Undo
          </Button>
          <Button variant="ghost" size="sm" onClick={onRedo} disabled={!canRedo} className="flex-1">
            <RedoIcon />
            Redo
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The generator tab.
 *
 * Lists every record the registry holds — **including the unrunnable ones**, greyed with their reason,
 * which is the spec's explicit rule. A tool that silently disappears turns "where is my generator" into
 * an afternoon of debugging.
 */
function GenerateTab({
  registry,
  libraryProblems,
  libraryPath,
  onReject,
  runtime,
  playhead,
  projectTree,
  document,
  sidecar,
  recalled,
  onAuthorManifest,
}: RightPanelProps): ReactNode {
  const records = registry?.all() ?? [];
  const assetChoices = useMemo(() => assetChoicesFrom(projectTree), [projectTree]);
  const frameGrab = useFrameGrab(document, playhead, sidecar);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [preset, setPreset] = useState<PresetId | undefined>(undefined);
  const [params, setParams] = useState<Readonly<Record<string, string | number | boolean>>>({});
  const [variantCount, setVariantCount] = useState<number | undefined>(undefined);
  const [lockedSeed, setLockedSeed] = useState<number | undefined>(undefined);
  /**
   * What each text parameter is bound to, when it is not being typed.
   *
   * The binding is kept rather than only its text, so the value can be re-read at submit time. Copying
   * the words in once would voice a stale draft the moment the note was edited — which is exactly the
   * round trip this feature exists to remove.
   */
  const [boundText, setBoundText] = useState<Readonly<Record<string, TextChoice | undefined>>>({});
  const [destination, setDestination] = useState<'media-browser' | 'timeline'>('media-browser');

  /*
   * A recall lands here, once per recall.
   *
   * The seed is set from it too — `undefined` unlocks, which is what "make another" means, and a
   * number pins, which is what "again" means. Both have to be written, or a recall after a
   * reproduction would silently keep the previous pin.
   */
  useEffect(() => {
    if (recalled === undefined) return;
    setSelectedId(recalled.generator);
    setPreset(recalled.preset);
    setParams(recalled.params);
    setLockedSeed(recalled.lockedSeed);
  }, [recalled]);

  /*
   * Notes and text clips, as things a script can be. Clips carry their words already; a folder listing
   * knows names but not contents, so the notes are read once and their openings filled in below.
   */
  const [notePreviews, setNotePreviews] = useState<ReadonlyMap<string, string>>(new Map());
  const textChoices = useMemo(() => {
    const base = textChoicesFrom(projectTree, document);
    return base.map((choice) =>
      choice.source === 'notes_file' ? { ...choice, preview: notePreviews.get(choice.ref) ?? '' } : choice,
    );
  }, [projectTree, document, notePreviews]);

  useEffect(() => {
    const api = bridge();
    if (api === undefined) return;

    const notes = noteChoicesFrom(projectTree);
    if (notes.length === 0) return;

    let cancelled = false;
    void Promise.all(
      notes.map(async (note) => {
        // A note that cannot be read is left without a preview rather than reported: it is still a
        // legitimate choice, and the run refuses with a reason if it is picked and still unreadable.
        const text = await api.readTextFile(note.ref).catch(() => undefined);
        return [note.ref, text === undefined ? '' : previewOf(text)] as const;
      }),
    ).then((entries) => {
      if (!cancelled) setNotePreviews(new Map(entries));
    });

    return () => {
      cancelled = true;
    };
  }, [projectTree]);

  const record: RegistryRecord | undefined =
    records.find((entry) => entry.manifest.id === selectedId) ?? records[0];

  /**
   * Where the output goes.
   *
   * Offered rather than inferred. The manifest's surfaces say where the *action* appears; they do not
   * say whether this particular run is material for the bin or a clip for the cut, and that is a
   * decision only the user makes.
   */
  const target: JobTarget =
    destination === 'timeline' && record !== undefined
      ? {
          kind: 'timeline',
          track: record.manifest.produces === 'audio' ? trackId('A1') : trackId('V1'),
          at: playhead,
        }
      : { kind: 'media-browser' };

  if (records.length === 0) {
    return (
      <div className="flex flex-col gap-2 p-4">
        {/* Both folders are read, so both are named. An empty state that mentions only the project's
            teaches the user to copy manifests into every new project, which is the work the shared
            library exists to remove. */}
        <p className="font-mono text-xs text-muted-foreground">no manifests in generators/</p>
        {libraryPath !== undefined && (
          <p className="font-mono text-xs break-all text-muted-foreground">shared library: {libraryPath}</p>
        )}
        {libraryProblems.map((problem) => (
          <p key={problem.file} className="flex items-start gap-1.5 font-mono text-xs text-destructive">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            {`${problem.file}: ${problem.detail}`}
          </p>
        ))}
        <Button variant="outline" size="sm" onClick={onAuthorManifest}>
          <FileJsonIcon />
          Author a manifest
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-1 px-3 py-2">
        <p
          className={cn(
            'flex items-center gap-1.5 font-mono text-xs',
            runtime.mode === 'comfyui' ? 'text-chart-2' : 'text-muted-foreground',
          )}
        >
          <CpuIcon className="size-3.5" />
          {runtime.detail}
        </p>
        {runtime.error !== undefined && (
          <p className="flex items-start gap-1.5 font-mono text-xs text-destructive">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            {runtime.error}
          </p>
        )}
        <Field orientation="horizontal" className="gap-2">
          <FieldLabel htmlFor="generate-destination" className="shrink-0 text-xs">
            Send to
          </FieldLabel>
          <NativeSelect
            id="generate-destination"
            size="sm"
            aria-label="Destination"
            className="flex-1"
            value={destination}
            onChange={(event) => setDestination(event.target.value as 'media-browser' | 'timeline')}
          >
            <NativeSelectOption value="media-browser">the media browser</NativeSelectOption>
            <NativeSelectOption value="timeline">the timeline, at the playhead</NativeSelectOption>
          </NativeSelect>
        </Field>
        <Button
          variant="outline"
          size="sm"
          onClick={onAuthorManifest}
          title="Turn a graph in this project into a generator"
        >
          <FileJsonIcon />
          Author a manifest
        </Button>
        <NativeSelect
          aria-label="Generator"
          className="w-full"
          value={record?.manifest.id ?? ''}
          onChange={(event) => {
            setSelectedId(event.target.value);
            setPreset(undefined);
            setParams({});
          }}
        >
          {records.map((entry) => (
            <NativeSelectOption key={entry.manifest.id} value={entry.manifest.id}>
              {entry.manifest.name}
              {entry.status === 'available' ? '' : ` — ${entry.status}`}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>

      {record !== undefined && (
        <GeneratorPanel
          record={record}
          params={params}
          {...(preset !== undefined ? { preset } : {})}
          {...(variantCount !== undefined ? { variantCount } : {})}
          {...(lockedSeed !== undefined ? { lockedSeed } : {})}
          {...(runtime.capabilities !== undefined
            ? { capabilityOptions: runtime.capabilities.enumOptions }
            : {})}
          assetChoices={assetChoices}
          textChoices={textChoices}
          boundText={boundText}
          onBindText={(key, choice) => {
            setBoundText((current) => ({ ...current, [key]: choice }));
            if (choice === undefined) return;
            // The field is filled straight away so the panel shows what will be spoken, and re-read at
            // submit so an edit between choosing and running is picked up rather than silently missed.
            void resolveTextChoice(choice, document, (path) => readProjectText(path)).then((text) => {
              if (text !== undefined) setParams((current) => ({ ...current, [key]: text }));
            });
          }}
          projectShape={document.resolution}
          frameGrab={{
            describe: frameGrab.available,
            busy: frameGrab.busy,
            // The grabbed path is written straight into the parameter: a user who asked for this
            // frame wants it used, and making them find the new file in a dropdown afterwards
            // would be a second step for a decision already made.
            grab: (key) => {
              void frameGrab.grab().then((asset) => {
                if (asset !== undefined) setParams((current) => ({ ...current, [key]: asset }));
              });
            },
          }}
          onChangeParam={(key, value) => setParams((current) => ({ ...current, [key]: value }))}
          onSelectAlternative={(group, chosen) =>
            // Through `selectMember`, which removes the alternatives rather than leaving them set: a
            // submit carries whatever the parameters hold, and a leftover voice sample would reach the
            // graph beside the enum the user has since chosen.
            setParams((current) => selectMember(group, current, chosen))
          }
          onChangePreset={setPreset}
          onChangeVariantCount={setVariantCount}
          onToggleSeedLock={() =>
            setLockedSeed((current) =>
              current === undefined ? Math.floor(Math.random() * 2 ** 31) : undefined,
            )
          }
          onRun={() => {
            /*
             * Bindings are resolved again here, not reused from when they were chosen. A note edited
             * between picking it and pressing Generate must be the version that gets voiced — reading
             * once at binding time is how a tool ends up confidently producing yesterday's script.
             */
            void (async () => {
              /*
               * A required either/or that nobody answered is refused here rather than submitted. §2.3
               * says one of the two must be given; sending neither leaves the graph to decide, which
               * is the ambiguity the group exists to remove.
               */
              const missing = unansweredGroups(exclusiveGroupsOf(record.manifest), params);
              const first = missing[0];
              if (first !== undefined) {
                onReject(`choose one of ${first.members.join(' or ')} before generating`);
                return;
              }

              const resolved: Record<string, string | number | boolean> = { ...params };
              for (const [key, choice] of Object.entries(boundText)) {
                if (choice === undefined) continue;
                const text = await resolveTextChoice(choice, document, (path) => readProjectText(path));
                if (text === undefined) {
                  // Refused rather than run with the stale value: the source the user pointed at is
                  // gone, and generating from what it used to say is worse than not generating.
                  onReject(`${choice.label} could not be read, so nothing was generated`);
                  return;
                }
                resolved[key] = text;
              }

              setParams(resolved);
              runtime.run({
                manifest: record.manifest,
                params: resolved,
                target,
                ...(preset !== undefined ? { preset } : {}),
                ...(variantCount !== undefined ? { variantCount } : {}),
                ...(lockedSeed !== undefined ? { lockedSeed } : {}),
              });
            })();
          }}
        />
      )}
    </div>
  );
}

/**
 * The variants tab.
 *
 * Shows the most recent group's candidates. Partial results are selectable the moment they land, which
 * is the behaviour the spec asks for and the reason the picker is driven by a derived selection rather
 * than by a "generation finished" event.
 */
function VariantsTab({ runtime, registry, onAcceptVariant, sidecar }: RightPanelProps): ReactNode {
  const [current, setCurrent] = useState<string | undefined>(undefined);
  const audition = useAudition(sidecar);

  const group = runtime.snapshot.groups[runtime.snapshot.groups.length - 1];
  const manifest = group === undefined ? undefined : registry?.manifestFor(group.generator);

  const selection = useMemo(() => {
    if (group === undefined || manifest === undefined) return undefined;
    return buildSelection({
      group,
      runs: runtime.snapshot.runs.filter((run) => run.group === group.id),
      manifest,
      // No cast: both sides are a candidate key. The `as never` that used to sit here was hiding the
      // fact that a run id was being passed where a key was required.
      ...(current !== undefined ? { current } : {}),
    });
  }, [group, manifest, runtime.snapshot.runs, current]);

  if (selection === undefined) {
    return (
      <div className="p-4">
        <p className="font-mono text-xs text-muted-foreground">nothing has been generated yet</p>
      </div>
    );
  }

  return (
    <div className="p-3">
      <VariantPicker
        selection={selection}
        auditioning={audition.playing}
        onAudition={() => audition.toggle(selection.current?.output?.path)}
        // A candidate **key**, not a run: a batched run carries several variants, so naming the run
        // would select all of them at once — and, since no candidate key ever equals a run id, in
        // practice selected none of them and fell back to the first.
        onSelect={(candidate) => {
          // Stopped on a change of variant: leaving the previous one playing under the new selection
          // is the one thing that would make an A/B comparison useless.
          audition.stop();
          setCurrent(candidate);
        }}
        onAccept={() => {
          const outcome = acceptSelection(selection);
          // `acceptSelection` returns nothing when no variant is ready; the picker disables the control
          // in that case, so this guard is for the keyboard path.
          if (outcome !== undefined && manifest !== undefined) onAcceptVariant(outcome, manifest);
        }}
        // Dismissed, not cancelled: a finished group has nothing to cancel, so the old call left the
        // group in the snapshot and the picker showing it — "Discard" did nothing at all.
        onDiscard={() => {
          audition.stop();
          runtime.dismissGroup(selection.group);
          setCurrent(undefined);
        }}
      />
      {audition.error !== undefined && (
        <p className="mt-2 flex items-start gap-1.5 font-mono text-xs text-destructive">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          {audition.error}
        </p>
      )}
    </div>
  );
}

/**
 * The segmentation tab.
 *
 * Bound to the selected clip, because a mask belongs to one clip's range. With nothing selected there is
 * no range to propagate over, and the panel says so rather than offering a control that cannot work.
 */
function SegmentTab({ document, selectedClip, masks }: RightPanelProps): ReactNode {
  const located = useMemo(
    () => (selectedClip === undefined ? undefined : locateClip(document, clipId(selectedClip))),
    [document, selectedClip],
  );

  const session = masks.session;
  if (session === undefined) {
    return (
      <div className="p-4">
        <p className="font-mono text-xs text-muted-foreground">select a clip to segment</p>
      </div>
    );
  }

  const source = located?.clip.kind === 'video' ? located.clip.source.asset : undefined;

  return (
    <div className="flex flex-col gap-2">
      <SegmentationPanel
        session={session}
        {...(masks.capabilities !== undefined ? { capabilities: masks.capabilities } : {})}
        {...(source !== undefined ? { onRun: () => masks.run(source) } : {})}
        onCancel={masks.cancel}
        onRemovePrompt={masks.removePrompt}
        onChangePropagation={masks.setPropagation}
      />

      {masks.error !== undefined && (
        <p className="flex items-start gap-1.5 px-4 font-mono text-xs text-destructive">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          {masks.error}
        </p>
      )}
    </div>
  );
}

/**
 * A project file's text, or a rejection.
 *
 * Throws rather than returning empty, because `resolveTextChoice` distinguishes "this is empty" from
 * "this could not be read" and the caller refuses the run on the second. A bridge-less build throws
 * for the same reason: it cannot read the file, and pretending otherwise would generate from nothing.
 */
async function readProjectText(path: string): Promise<string> {
  const api = bridge();
  if (api === undefined) throw new Error('no bridge');
  const text = await api.readTextFile(path);
  // `undefined` from the bridge means the file is not there; throwing keeps "missing" and "empty"
  // distinct all the way up to the refusal, which is the distinction the caller acts on.
  if (text === undefined) throw new Error(`${path} could not be read`);
  return text;
}
