# Integration product artwork

These seven unmodified local assets identify actual products. They are separate
from the editor/Agent ToolBrandIcon catalog and never establish native support,
connection identity, account state or provider permissions.

`IntegrationProductIcon` statically imports the files. Colored assets preserve
their original pixels/colors; the monochrome GitHub source uses the theme's
foreground mask. No runtime CDN, grayscale filter or fallback product is used.

`provenance.json` records source, version/retrieval date and exact SHA-256. Jira,
GitLab and GitHub art comes from Devicon v2.17.0 (MIT, see LICENSE.devicon.txt).
WeKnora's favicon comes from Tencent's own repository; its complete license and
third-party notices are preserved in LICENSE.WeKnora.txt. The other favicons come
from their official product sites; no explicit open artwork license was found.
Do not describe all artwork as MIT or claim trademark ownership/endorsement.

Copies of this declaration, provenance and licenses are in
`resources/licenses/integrations/`, covered by the existing resource inclusion
rule. Asset/provenance/license updates must update those copies together.
Actual packaged loading, decoding, theme/scaling and visual acceptance remain
unverified under the user's no-tests/builds restriction.
