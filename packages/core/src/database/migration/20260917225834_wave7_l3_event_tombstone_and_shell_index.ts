import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260917225834_wave7_l3_event_tombstone_and_shell_index",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`event\` ADD \`tombstone_digest\` text;`)
      yield* tx.run(
        `CREATE INDEX \`session_message_session_call_id_seq_idx\` ON \`session_message\` (\`session_id\`,json_extract("data", '$.callID'),\`seq\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
