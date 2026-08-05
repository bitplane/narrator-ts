/** What the device reports in `io_Error` rather than speaking. */
export class SpeakError extends Error {
  constructor(
    message: string,
    /** 1-based offset of the offending character, when the parser found one. */
    readonly at?: number,
  ) {
    super(message)
    this.name = 'SpeakError'
  }
}

export function invalidVoice(): never {
  throw new SpeakError('invalid voice data')
}
