import { z } from 'zod';
import { zUid, SCHEMA_TAGS } from './common.js';

export const zFixture = z.object({
  fixture_id: z.string().min(1),
  title: z.string().min(1),
  source_session_id: z.string().optional(),
  input: z.any(),
  pinned_context: z.array(z.object({ uid: zUid, revision_id: z.number().int() })).optional(),
  tags: z.array(z.string()).default([]),
  notes: z.string().optional(),
  retired: z.boolean().default(false),
});
export type Fixture = z.infer<typeof zFixture>;

export const zFixtures = z.object({
  schema: z.literal(SCHEMA_TAGS.fixtures),
  circuit: zUid,
  fixtures: z.array(zFixture).default([]),
});
export type Fixtures = z.infer<typeof zFixtures>;
