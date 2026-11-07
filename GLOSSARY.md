# Glossary

Terms for pi-memory's scoped-memory model. Implementation detail belongs in specs and issues, not here.

## Scope

A named bucket of memory that owns its own files. Two kinds exist: **global** and **project**.

## Scope id

The string that identifies a scope in tool calls, config, env vars and injected headings. `global`, or `project:<slug>` (optionally `project:<slug>#<hash>` to disambiguate two projects with the same basename). The display form never carries the hash; a listing appends `#<hash>` only when the bare slug is shared.

## Scope set

The list of scope ids a session reads and writes. The session's own project scope is always in it; every configuration layer supplies only the *extra* scopes.

## Extra scopes

The part of the scope set that configuration controls: the scopes beyond the session's own. Supplied by the command layer, the env var, or the project config file, in that precedence order.

## Own scope

The scope the session writes to: the project scope of the session's project root, or `global` when the session is outside any repo. Always in the scope set; the only other writable scope is `global` itself.

## Active scope set

The scope ids a session reads by default: the own scope plus the configured extra scopes. The default read scope set; writes default to the own scope instead.

## Injected context

The memory block the agent sees at the start of a turn: one labelled section per scope in the active scope set, followed by the auto-retrieved search results.

## Global scope

The scope holding memory that is not tied to any project. Opt-in per session; never auto-included.

## Project scope

The scope belonging to one project root. Its id is `project:<slug>`, where the slug is the project root's basename unless overridden by the project config.

## Project root

The git root of the session's working directory, or the session's cwd when not inside a repo. It names the project scope, hosts the project config file, and is the anchor for the uniqueness hash.
