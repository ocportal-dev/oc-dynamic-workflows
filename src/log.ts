/** The prefix every line this plugin writes to the console starts with. */
export const PREFIX = "[oc-dynamic-workflows]"

const reported = new Set<string>()

/**
 * The catch handler of a promise nobody awaits.
 *
 * A timer callback, an event handler, and a cleanup path cannot throw, so every floating
 * promise ends here. The first failure of one site is reported; the rest are swallowed, so
 * a broken storage cannot fill the console.
 */
export function swallow(site: string): (error: unknown) => void {
  return (error: unknown) => {
    if (reported.has(site)) return
    reported.add(site)
    console.warn(`${PREFIX} ${site} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
