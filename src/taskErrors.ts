/** Archived cards stay readable. Mutations from the phone and the board service reject them. */
export const ARCHIVED_READONLY = "archived_readonly";

export class ArchivedReadonlyError extends Error {
  readonly code = ARCHIVED_READONLY;
  readonly statusCode = 409;

  constructor(message = "archived tasks are read-only") {
    super(message);
    this.name = "ArchivedReadonlyError";
  }
}
