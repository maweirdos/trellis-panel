# Integration product artwork

These seven active unmodified product marks identify actual products. They are separate
from the editor/Agent ToolBrandIcon catalog and never establish native support,
connection identity, account state or provider permissions.

`IntegrationProductIcon` statically imports the files. Colored assets preserve
their original pixels/colors; the monochrome GitHub source uses the theme's
foreground mask. No runtime CDN, grayscale filter or fallback product is used.

`provenance.json` records source, version/retrieval date and exact SHA-256. Jira,
GitLab and GitHub art comes from Devicon v2.17.0 (MIT, see LICENSE.devicon.txt).
WeKnora's favicon comes from Tencent's own repository; its complete license and
third-party notices are preserved in LICENSE.WeKnora.txt. Gitee and Feishu favicons come
from their official product sites. The blue DingTalk PNG is the product mark
extracted from the installed Crux artifact with REA; no implementation code was
copied. No explicit open artwork license was identified for these product marks.
Do not describe all artwork as MIT or claim trademark ownership/endorsement.

The previous yellow DingTalk website favicon is retained as a historical unused
asset; it is no longer imported by the integration UI. Per-asset provenance pins
both files and the source artifact rather than silently changing their identity.

Copies of this declaration, provenance and licenses are in
`resources/licenses/integrations/`, covered by the existing resource inclusion
rule. Asset/provenance/license updates must update those copies together.
Frontend visual/theme checks are recorded separately. Actual packaged loading
and decoding remain unverified until their native/package gate is authorized.
