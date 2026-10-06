export class NotImplementedError extends Error {
  constructor(adapter: string, method: string) {
    super(`The "${adapter}" creator source does not implement ${method} yet.`);
    this.name = "NotImplementedError";
  }
}
