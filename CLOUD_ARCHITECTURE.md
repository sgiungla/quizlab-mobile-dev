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
3. merge by stable question IDs and append-only attempts/exams where possible;
4. resolve simultaneous edits through revision + updated_at instead of replacing blindly;
5. clear dirty markers only after a confirmed server write.

Deletes will use tombstones before full two-way sync is enabled.

## Safety
Never use a Supabase service-role key in this repository or in browser code.
