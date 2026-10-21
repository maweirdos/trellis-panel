# Saved Knowledge Document Reading

## 1. Scope / Trigger

Read before changing saved product-document preview, document-relative images or
the artifact-specific local-open action. The artifact body/revision is immutable;
the current disk file and referenced image files are separate facts. Keep native
save/publication authorization, ordinary task readers and source excerpts intact.

## 2. Signatures

```ts
interface KnowledgeDocumentContext {
  expectedRoot: string; sessionId: string; artifactId: string; revision: string
}
api.knowledgeAccess.artifactImage({ ...context, src: string })
  : Promise<KnowledgeResult<KnowledgeArtifactImage>>
api.knowledgeAccess.artifactOpenLocal({ ...context, acknowledgeChangedFile?: boolean })
  : Promise<KnowledgeResult<KnowledgeArtifactOpenLocalResult>>
```

Channels are `knowledge-access:artifact-image` and
`knowledge-access:artifact-open-local`; use the central registry/preload. Shared
contracts/limits are in `src/shared/knowledge-document-assets.ts`. Main implements
`readKnowledgeArtifactImage` and `openKnowledgeArtifactLocal` in the knowledge
document service; the renderer never supplies an authoritative root or file path.

## 3. Contracts

Main captures the current project/generation, checks expected-root equivalence,
reads the exact saved artifact ID/revision and verifies its session. Check project
generation and sender liveness across asynchronous reads and before OS dispatch.
Do not infer a document/version from a Markdown title or basename. The filename
entry is backed by actual receipts; any Agent-answer link opening the same saved
preview must bind its full target to the appropriate causal receipt, not disk B
or a newer version at the same path.

Images resolve relative to the artifact document directory, under the current
project. No network/UNC, arbitrary URL scheme, absolute target, root escape,
redirected descendant, folder or unsupported format. Walk ancestors before
realpath/open; verify ordinary/readable files, bounded reads, byte MIME and raster
dimensions before expensive decoding. PNG/JPEG/WebP limits are 5 MiB each,
8192px per dimension and 16*1024*1024 pixels. Main allows at most three concurrent
image reads per sender. The document renderer bounds automatic references to
eight and retained image bytes to 20 MiB, including duplicate/failure handling.

`KnowledgeArtifactImage` returns validated `dataUrl`, `mimeType`, `byteLength`,
`contentHash`, `width`, `height`, project `relativePath` and
`resource: 'current-local'`. Only this validated data becomes an img source;
untrusted Markdown src never navigates/fetches directly in this document path.
Do not loosen global CSP, enable raw HTML/file images or download external assets.
These resource bytes are current local files, NOT archived image snapshots.

The artifact-specific OS action supports saved Markdown only. Main derives its
path, reads the current UTF-8 file and compares its revision. If it differs from
the preview, require a further explicit acknowledgment before opening the current
file. Never overwrite disk B, export a hidden copy of A or claim Word/PDF fidelity.
The narrow OS opener retains its independent checks; its optional `stillCurrent`
callback gates final dispatch. External OS opening is not transactionally atomic
with later filesystem replacement/application reading.

## 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Malformed input/path, unsupported MIME/extension or invalid dimensions | `E_INVALID_ARG`; no image/OS dispatch |
| No open project | `E_NO_PROJECT` |
| Foreign artifact session, escaped/redirected path, non-regular/unreadable/oversized file or concurrency bound | `E_DENIED` |
| Missing file/directory | `E_NOT_FOUND`; retain saved body preview |
| Project/sender changed or local revision differs without acknowledgment | `E_CONFLICT`; no stale UI/OS action |
| Read/OS association failure | `E_IO`; visible error, no claimed success |
| Old preload lacks image/open capability | Discoverable full-exit/restart guidance, never arbitrary opener fallback |

Failures use the standard typed envelope. An acknowledged open returns
`{opened:true,currentRevision,differsFromPreview}`; it does not replace the saved
preview or prove that another application rendered the file. Image decode failure
in the renderer remains a readable failure/alt state rather than a broken image.

## 5. Good / Base / Bad Cases

- Good: open saved A through its filename while disk is B; A stays readable,
  current-image provenance is disclosed, and local opening warns before B opens.
- Base: a project-relative PNG displays proportionately after main validation;
  a valid Mermaid fence uses the existing strict sanitized renderer.
- Bad: a model-written fake link fabricates a saved document, a symlink opens an
  outside image, or a missing capability silently launches an arbitrary file.

## 6. Tests Required

Use actual shared/main/preload/renderer paths with owned project fixture files
and stubbed OS handlers. Cover root/session/revision/sender changes, encoded paths,
real junctions, malformed/oversized raster headers before decode, MIME/byte limits,
duplicate and failed image requests, concurrency, current A/B acknowledgment,
missing/denied targets and handler failure. No production file/model/knowledge call.

Mounted document reading must cover receipt-name entry and known/forged links,
exact body/raw bytes, chapter anchors including CRLF/repeats/fences, Markdown
tables, Mermaid, image success/failure, raw/outline scroll, Settings suspension,
late reads and light/dark/font/narrow layout. Retain ordinary source-reader,
chronology, compact-row alignment and external/local navigation regressions.

## 7. Wrong vs Correct

Wrong: trust a generated file link, read the latest disk body for an old receipt,
or permit `file:`/remote img URLs globally to make pictures appear. Correct: bind
the saved artifact identity, render its exact body in the shared Modal, resolve
bounded project assets through main and label current-resource/current-file facts.
