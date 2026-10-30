import { DatabaseSync } from "node:sqlite";
import type { Message } from "@vo/shared";
import { newId } from "../domain/ids.ts";

export function listMessages(
  db: DatabaseSync,
  projectId: string,
): Message[] {
  return db
    .prepare(
      `SELECT id, project_id, role, content, created_at
         FROM messages WHERE project_id = ? ORDER BY seq`,
    )
    .all(projectId) as unknown as Message[];
}

export function insertMessage(
  db: DatabaseSync,
  input: {
    project_id: string;
    role: Message["role"];
    content: string;
  },
): Message {
  const id = newId();
  db.prepare(
    `INSERT INTO messages (id, project_id, role, content, seq)
     VALUES (?, ?, ?, ?,
       (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE project_id = ?))`,
  ).run(
    id,
    input.project_id,
    input.role,
    input.content,
    input.project_id,
  );
  return db
    .prepare("SELECT * FROM messages WHERE id = ?")
    .get(id) as unknown as Message;
}
