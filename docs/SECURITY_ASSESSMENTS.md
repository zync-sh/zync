# Security hardening audit

Open **Security hardening audit** from a Linux SSH host's workspace **+** menu, then choose
**New assessment**. Choose a preset,
adjust **Areas**, then select **Run assessment** and approve the host, scope and
access. No account, scanner, agent or Python installation is required.

Use **Security hardening audit** in the global navigation bar, **+** menu or command
palette to browse saved reports from all hosts. Search by report or host and filter
by SSH account and endpoint. Reports open offline, including after a saved host is
removed. Row actions export or delete a report; accepted risks are kept by default.
Browse labels follow **Show host addresses in lists**. Report details and exports
retain the recorded endpoint.
To start from the global view, choose **New audit**, select a saved Linux SSH host
and continue to its setup. Connect explicitly if it is offline, choose the checks
and use **Run assessment** to review and approve the run. Selecting a host does
not connect or start an assessment. **Back** returns to saved reports; **Resume
audit** restores the current in-memory setup or unsaved result. Choosing another
host replaces that draft. The host workspace remains an alternative entry point.
Back remains available if the selected saved host is removed.

Saved reports and accepted risks remain available while the host is offline.
New assessment shows a connection card until you use **Connect** or **Reconnect**.
Assessment controls appear after connecting, with any previous preset and area
choices retained. Running still needs separate approval; connecting does not
start an assessment.
Use **Cancel** to stop a pending connection. Connection failures show a short
reason, with diagnostic information under **Connection details**. After connecting,
keyboard focus moves to the setup heading if you stayed in the connection card.
Switching panes also cancels that focus handoff. Connecting from this card keeps
your current shell tabs and workspace selection.

## Choose what to check

The native catalog contains **183 checks and observations across 15 areas**.
Only selected areas run. Opening the pane, changing choices and reconnecting do
not start an assessment.

| Area | Checks | What it covers |
| --- | ---: | --- |
| Host baseline | 38 | Kernel, named-file permissions, SSH defaults, accounts, network, mounts and maintenance |
| Additional host protections | 26 | Account hygiene, isolation, audit, clock and runtime controls |
| SSH connection-policy preview | 8 | Current standard configuration with captured connection inputs |
| Nginx | 13 | Standard service unit and named configuration file |
| Apache | 8 | Standard service unit |
| Docker Engine | 13 | Standard unit, default local socket and daemon observations |
| Docker containers | 16 | Aggregate settings for a sample of up to 20 running containers |
| PostgreSQL | 8 | Standard service unit |
| MySQL | 8 | Standard mysql.service unit |
| Redis | 13 | Standard service unit and named configuration file |
| Jenkins | 8 | Standard service unit |
| PostgreSQL runtime | 8 | Selected settings, login counts and current HBA-file diagnostics |
| MySQL runtime | 6 | Selected settings and optional administrative-account count |
| Redis runtime | 6 | Selected settings and simulated default-user command permissions |
| Jenkins runtime | 4 | Security flag, controller executors, CSRF context and anonymous metadata access |

Presets are editable starting scopes: **General host** and **Router** select 72
checks, **Web server** 93, **Database server** 101 and **CI / build host** 109.
Authenticated runtime areas are always an explicit additional choice. Router
expects IPv4 forwarding to be enabled; other presets keep that setting contextual.
A preset expresses intended use, not automatic role detection.

This is a focused configuration review, not a full host/application audit,
compliance certification, vulnerability scan, container-image analysis or penetration
test. A passed condition does not establish that the host is secure.

## Access and application connections

Host checks use the SSH account's existing privileges, including root when already
logged in as root. The host needs `/bin/sh`, GNU coreutils `/usr/bin/timeout` and
utilities used by selected areas in standard paths. Missing tools, permissions
or uninterpretable responses stay unevaluated.

**Use sudo** is optional, off by default and approved for each run. It permits only
fixed protected reads, never a root shell or sudoers changes. If sudo challenges,
Zync asks for the connected user's password in a masked dialog and sends it through
the owned SSH channel's stdin. Existing sudo cache/passwordless rules can avoid a
prompt. MFA, multiple prompts and TTY-only rules are unsupported. Rejected/expired
challenges stop without automatic retries; closing the dialog cancels the run.
Normal server authentication and logging policies still apply.

Runtime areas show **Add access** for the selected service. Enter its local port,
username and password or Jenkins API token; PostgreSQL also needs a database.
Use a dedicated observation account with only required read permissions. Optional
privileged views can remain unavailable; do not grant broad administrative access
just to evaluate every row. Blank PostgreSQL passwords and blank Redis credentials
are allowed only when explicitly configured for the run.

Application connections target **127.0.0.1 on the SSH host**:

- PostgreSQL and Redis use native clients over SSH direct-tcpip, without opening a
  desktop listening port. PostgreSQL uses the SSH-protected local connection;
  inner TLS-only database rules may reject it. Redis observes plaintext local
  endpoints only. Zync does not weaken server TLS policy.
- MySQL uses an existing supported Oracle MySQL client for Linux in a dedicated
  non-PTY SSH channel, with option/login files disabled and TLS required. Passwords
  go only to a framed stdin prompt, never arguments, environment or temporary files.
  The client observer supports at most **79 UTF-8 password bytes**. Longer values
  are rejected without truncation; keep the password unchanged and use service checks.
- Jenkins uses fixed local HTTP metadata GETs over SSH, without redirects or script
  console calls. Custom context paths and HTTPS-only local endpoints are unsupported.
  Public metadata can remain observable when the supplied token is not verified;
  the evidence says so. A true security flag does not prove correct authorization.

Sudo passwords and application secrets stay in memory for this run. They are not
logged, saved to Vault, synced, exported or reused automatically for retries.
Native owned secret buffers clear on drop; JavaScript/transport erasure cannot
be guaranteed. Application authentication can create normal server logs.

## Read the results

The report records the scope and preset that ran. Editing the next run's choices
does not relabel it. Use quick triage, search and result/category/area filters;
expand rows for explanations and technical evidence.

| Result | Meaning |
| --- | --- |
| Needs attention | Evidence meets an authored review condition; not a confirmed vulnerability |
| Informational | Contextual observation without an automatic pass/fail decision |
| Passed | Only the named condition met the baseline |
| Needs elevated access | A protected read was denied on an unelevated non-root run |
| Evidence unavailable | Information was missing, failed or could not be interpreted |
| Not applicable | Evidence establishes an exclusion from the stated scope |

Coverage separates evaluated, elevated-access, other unavailable and not-applicable
checks. Counts are not a security score. Priority ranks evidenced attention findings,
not vulnerability severity. Source labels distinguish runtime values, calculated
policy, named files, metadata, services and containers. **Technical details** retains
exact evidence, rule version and guidance-review date. **Read source guidance**
appears inside **How to address it** when available, otherwise in Technical details.

Expand a **Needs attention** finding for its **Recommended next step**. Where a
guide is available, **How to address it** shows ordered change and verification
steps, with impact and recovery explained separately. Review the finding's scope and adapt the advice
to your workload before changing the host. Zync does not apply these changes.
Unavailable checks show a collection **Next step** instead of a configuration fix.
Older saved/imported reports retain their recorded advice; missing guides are not
added retrospectively.

**About this assessment** shows the audit-rule revision and its recorded date,
with a readable check-profile name such as **Ubuntu 24.04** or **General Linux
checks**. General Linux coverage remains limited. Machine identifiers remain in
exported metadata for traceability.

The observation appears once in the row heading. Expanded results keep the expected
condition, next step and context together. New reports include a concise scope note;
the complete scope remains in **Technical details**. Older reports show their original
scope text. Technical metadata uses two columns on wide panes and stacks on narrow
panes, with evidence and full scope spanning the available width.

**Retry with sudo** handles confirmed protected-read denials. **Try with sudo**
handles eligible protected-read failures with an unconfirmed cause. Both require
approval, repeat the report's entire selected scope and replace its results. They
do not guarantee access. Missing tools, named inputs, deadlines and malformed
evidence do not get speculative elevation badges. Root and already sudo-approved
reports do not offer elevated retries. Runtime areas need fresh application access.

Profiles authored for Ubuntu 22.04/24.04 and Debian 12/13 identify OS-specific scope;
other releases use limited generic coverage. Selection does not prove full host
qualification or certification. New runs use **zync-linux-7 (2026-10-25)**.

## Evidence limits

- SSH defaults describe configuration defaults. The optional connection preview
  applies numeric addresses and the username to current `/etc/ssh/sshd_config`,
  using supported `-G -T` or legacy `-T`. It cannot establish daemon arguments,
  custom configuration or already-loaded policy. Unknown DNS-dependent Match
  context stays unavailable. Neither SSH view receives Passed.
- Service areas check named units/files. Custom layouts and applications inside
  containers need separate review. An unloaded unit is outside that unit's scope,
  not proof the application is absent. Nginx/Redis file declarations do not establish
  included or running configuration.
- Docker uses fixed local Engine API GETs through `/var/run/docker.sock` with curl/jq;
  no CLI plugins, remote contexts or rootless sockets. Container checks sample at
  most 20 running IDs and disclose limits. Names, environments, commands, labels and
  mount paths are not exported. Aggregate observations cannot identify every
  affected container or establish fleet coverage.
  Comparison and acceptance identities include every sampled check outcome and
  unavailable inspection, including IDs outside the displayed matching-ID list.
- PostgreSQL HBA diagnostics describe the **current file**, not last loaded policy,
  and may need extra view access. TLS support does not prove enforced TLS.
  Runtime checks do not establish complete authorization or application security.
  Redis ACL simulation executes no simulated command and reads no ACL hashes.
- Network checks cover the current namespace, not internet reachability or cloud
  firewalls. Account evidence contains counts, not names/passwords/hashes. File
  checks do not cover extended ACLs or all parents/includes. A clean package audit
  does not establish patch freshness or absence of vulnerabilities.

## Save reports and export

After an assessment, choose **Save report** and give it a name. **Save as new**
keeps a separate copy. **Replace saved report** explicitly updates a chosen copy
for the same host/account and recorded SSH key, including its accepted-risk notes. Replacement
detects changes from another pane instead of silently overwriting them.

**Saved reports** appears inline by default when you open Security hardening audit, with this
host/account's dated records and check counts. The report list loads local summaries
instead of retaining all report bodies. The one-time acceptance-note migration
reads saved bodies to separate their notes. Click a report row, or focus it and press
Enter/Space, to review it. Compare, Export and Delete are independent row actions.
The list shows five records per page. Setup and report details each have one **Back**
button; the library retains the selected view, risk search and page. **Latest assessment**
returns to the unsaved latest report. Reports can be opened without a live SSH connection and
survive app restarts. Opening, importing, saving and comparing never start checks.
Save/replace and delete confirmations still use dialogs. Runs are never saved automatically.
The setup card appears only in **New assessment**, with its cancel control during
a run. Back preserves scope choices and clears one-run credentials and sudo consent.

The local library holds up to **50 reports / 64 MiB of report data**, with a bounded
database cache. When full, replace or delete a report; nothing is silently evicted.
Reports contain host/system metadata and are stored outside Vault, without Vault
encryption or sync. Device file permissions apply.

The **Export** menu includes every retained finding, regardless of UI filters/pages:

- **JSON:** version-3 Zync report with complete normalized evidence and accepted-risk
  reasons/expiry. Import JSON to preview it or use it for comparison. Older version-2
  reports remain supported without inventing missing identity or notes.
- **CSV:** one row per check, with host, date, result, priority, evidence, guidance
  and active accepted-risk information. Fields are quoted; formula-like text is
  prefixed for spreadsheet viewing. Use JSON when exact programmatic values matter.
- **Excel (.xlsx):** formatted Summary and Findings sheets, frozen headings and
  filterable results. Baseline and Preset appear once in Summary; Area stays with
  each finding. CSV retains all three columns for combining exports. Evidence is
  written as text, not spreadsheet formulas.

JSON retains any structured guidance recorded with a finding. CSV and Excel
include it in one **How to address it** column with labeled change, impact,
verification and recovery sections.

All exports are local and require a destination. No account or Google Sheets
connection is required. Separate accepted-risk JSON import/export remains available
under **Report actions**.

## Compare and annotate

Use a saved report's compare action or **Report actions → Compare imported report**.
Comparison
requires matching endpoint/account, verified SSH host key, preset revision and
per-finding target/rule identities. A later report cannot become an earlier baseline.
Missing, unavailable, unselected, revised or recreated targets never become
**Resolved**; only comparable earlier attention followed by Passed does. Legacy
reports missing provenance remain inspectable without invented comparison identity.
Comparing standard-access and sudo reports also shows **Now assessed** and
**No longer assessed** when a matching check gains or loses readable evidence.
These are coverage changes, not fixes. Both appear in the default **Changes** view.
Expand a comparison row for the earlier/current result and evidence. If comparable
checks are unchanged, the view says so and offers access to checks not compared.
Imports are unsigned user-provided data, not authenticated evidence.

An **Accepted risk** adds a reason and an expiry of at most 90 days to an attention
finding. It binds to that host, preset, target, rule and exact evidence. Changed
evidence or expiry makes it inactive. It never changes status, priority or coverage.
**Accept risk** saves an independent acceptance on this device. Open **Accepted
risks** beside Reports to search the host/account's saved acceptances, inspect
reasons and expiry, or remove one. Only matching, unexpired evidence is accepted;
expired notes remain visible and removable. Imported notes are previewed in the
current pane; **Save report** records them with that snapshot. Choose **Save accepted
risks locally** to make them reusable entries in the list. **Export accepted risks** writes a file.

An expired newer acceptance never reactivates an older one in the report or its
spreadsheet export. Conflicting actions from another pane require a refresh,
including when an acceptance was removed and created again.

Deleting a report keeps acceptances by default. Its optional **Also remove matching
accepted risks** checkbox removes only unchanged acceptances recorded by
that report; separately renewed acceptances are kept. Conflicting changes stop
the deletion instead of partially deleting data. Historical reports keep their
read-only **Recorded acceptance** notes even after an acceptance is removed.
Existing embedded notes are copied into the independent list once, without
reactivating acceptances that were later removed. Expiry/removal never changes
the underlying check status. Saving/exporting includes no sudo or application credentials.

## Limits, cancellation and privacy

Remote collection has a 150-second deadline, or 240 seconds including sudo entry,
plus a two-second kill grace. Protected producers receive four seconds after
authentication and a one-second grace; bounded projections can wait for entry.
Native collection has a 160/250-second limit. Each application observer has a
shared 25-second budget and five-second channel-open limit. Received data is capped
at 512 KiB per owned connection/exec call; native clients also cap outgoing data
at 512 KiB per connection. Jenkins/MySQL can make several bounded calls within
the observer deadline. The whole run has a five-minute budget with bounded cleanup.

At most two assessments run, one per SSH connection, without a queue. Reports are
capped at 8 MiB, individual interpreted evidence at 512 KiB, retained findings at
1,000 and rendered rows at 25 per page. Cancel, pane close and transport change
prevent late publication and close owned channels. GNU timeout is the fallback
if SSH is lost; this is not a hostile-host sandbox or hard host CPU/RAM quota.

No settings, packages or services are changed. The collector installs nothing,
does not recursively scan files or create remote report/temp files. No external
assessment lookup or upload occurs. Exports contain host/system metadata; review
before sharing. Imports are capped at 8 MiB of report data plus 1 MiB/1,000 annotations.
There is no automatic saving, scheduling, sync or remediation. Pane close or
connection identity change clears unsaved report/review state and access. Explicitly
saved reports remain in the local library until deleted.
Independent acceptances use the same local database/cache, with a separate
5,000-record / 64 MiB payload limit. They stay outside Vault encryption and sync.
