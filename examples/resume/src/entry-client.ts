// The ONLY script a resumable page ships: the generated loader entry —
// delegation listeners for the build-wide event union, plus lazy references
// to the QRL registry and the resume runtime (both load on first
// interaction, never before).
import 'virtual:sigx-resume/entry';
