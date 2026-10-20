// How a person calls a Host: `Vite`, `Next.js`. The posture block names the
// Host with it and `init` says which Host it set up for. A type of its own, so
// it is never taken for the address a Host is bound to, which the posture block
// also prints, nor for a Connector's name as `--connector` spells it
// (`ConnectorName`). The core knows no Host: each Connector, and `init`, names
// its own.

declare const HOST_NAME: unique symbol

export type HostName = string & { readonly [HOST_NAME]: true }

/** A Host's name, as a person calls it. */
export function hostName(name: string): HostName {
  return name as HostName
}
