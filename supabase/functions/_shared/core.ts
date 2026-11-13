// The parts of packages/core the Edge Functions use. Imported by relative path with ".ts"
// extensions, which Deno needs (the local runtime and `supabase functions deploy` both bundle it).
export * from '../../../packages/core/src/couriers/index.ts';
export * from '../../../packages/core/src/geo/index.ts';
export type { CourierMode, SupportedCarrier } from '../../../packages/core/src/domain.ts';
