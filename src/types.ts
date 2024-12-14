export type CommandRequest = {
  command: string; // command fed to the commander program
  payload?: Uint8Array; // additional binary data unsuitable for transmission within `command` string
  id?: number; // optional id to echo within the corresponding response
};

export type CommandResponse = {
  status: "SUCCESS" | "FAILURE" | "PENDING";
  data?: any;
  error?: string; // error message, if status is "FAILURE"
  id?: number; // the id from the corresponding request, if it had one
  tx?: string; // the hash of the transaction, if it had a transaction
};

// pragmatic helpers to avoid typos
export const SUCCESS = "SUCCESS";
export const FAILURE = "FAILURE";
export const PENDING = "PENDING";
