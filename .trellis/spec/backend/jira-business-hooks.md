# Jira Business Hooks

## Scope

Jira intake and status synchronization may create or update a platform task
through the current desktop account and device. The GUI issues a separate
protected `business-hook` credential after the selected team connection is
verified. The Daemon reads that credential without opening the DesktopTeamStore
and without receiving a team secret through IPC.

The credential binds the Jira Hook to the original team connection, account,
device, project and service epoch. Disconnect, account/device revocation,
project loss or credential replacement removes the business Hook credential.
An offline or revoked connection returns unavailable or unknown; it never uses
the Jira credential as a substitute team identity.

## Jira plan target

Jira plans that enable platform task intake set `platformSpaceId` explicitly.
The Daemon verifies that the current team account can access that Space before
creating a task. A plan without a target Space keeps the existing Jira-local
intake behavior and cannot claim platform task creation.

## Effects and mappings

The team service retains one canonical mapping for `(instanceId, issueId)` and
the returned platform `TeamTaskRef`. A second task mapping is rejected. The Jira
workspace repository retains the original Jira job/effect receipt and the same
platform reference. A platform task is created only after the Jira effect has a
durable owner. Platform create/update commands use their own UUID, current team
epoch/revision and the existing Crux task command writer.
The response must return the same project, account, service epoch and task
identity before the Jira receipt is settled.

An uncertain platform command remains unresolved under its original command
identity. A retry reads the original receipt or reconciles the original task;
it does not create a second platform task or issue. Confirmed platform effects
are recorded with provider job/command identity and a payload digest; the same
effect UUID with another payload is rejected.

Status updates use the existing task mutation authority and the mapped local
status ID. Ambiguous mappings, unavailable target Space, changed task identity,
or changed task inputs block the effect and preserve the Jira receipt.

## Limits

The business Hook uses the existing protected credential directory, task/service
request limits and Jira evidence bounds. It does not create a scheduler, copy
Jira credentials into team records, modify an external repository, or infer a
target Space from the first visible task.

## Required verification

Use isolated OS TEMP team accounts, device credentials, Jira responses and
project snapshots. Verify platform task creation/linkage, mapped status update,
duplicate command UUID, changed payload, missing/revoked credential, offline
worker, target Space loss and acknowledgement-unknown recovery. Run root and
team-service typecheck/build and the applicable ACP guard.
