# QuizLab Cloud architecture

The PWA stays offline-first. Cloud is an additional synchronization layer, never the only copy.

## Ownership model
- One web app for everyone.
- Each person signs in with a separate Supabase Auth user.
- Profile and progress are private via Row Level Security.
- A bank has its own owner and can later be marked shared without sharing personal progress.
- The same course can therefore exist for Salvo and another user without mixing attempts, grades, review queues or simulations.

## Sync model
Local data remains the working copy in IndexedDB.
Each course change is marked dirty locally.
When online and authenticated:
1. push local dirty profile/course changes;
2. pull newer cloud revisions;
3. write progress through an atomic optimistic-concurrency RPC;
4. on a revision conflict, merge append-only attempts/exams plus timestamped mutable state and retry against the newest revision;
5. propagate reset timestamps so performance/review/full-cycle resets cannot be undone by a stale device;
6. clear dirty markers only after a confirmed server write.

Per-user deletes and Admin global retirements use tombstones. Direct authenticated writes to progress rows are disabled from v0.7 onward so stale clients cannot bypass revision checks.

## Safety
Never use a Supabase service-role key in this repository or in browser code.
