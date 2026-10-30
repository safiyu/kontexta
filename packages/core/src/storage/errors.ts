/** Thrown when a well-formed remote op cannot be applied on this machine; the pull records it and moves on. */
export class UnappliableOpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnappliableOpError";
  }
}
