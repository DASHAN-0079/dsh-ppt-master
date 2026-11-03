/**
 * Cordis entry point for the DeepSeek Harness bundle.
 *
 * The package contributes one skill provider; the skill body stays byte-identical to the
 * upstream distribution, and everything host-specific lives in the adapter note the provider
 * appends at load time.
 */

import { definePptMasterSkill } from './skill.js'

export const name = 'dsh-ppt-master'
export const inject = ['skills']

/**
 * Register the vendored skill.
 * @param ctx - Context carrying the skill registry.
 * @param config - `name`, `description`, `debug`.
 */
export function apply(ctx, config = {}) {
  const options = {}
  if (typeof config.name === 'string' && config.name.length > 0) options.name = config.name
  if (typeof config.description === 'string' && config.description.length > 0) options.description = config.description
  if (config.debug === true) {
    const logger = typeof ctx.logger === 'function' ? ctx.logger('dsh-ppt-master') : undefined
    options.debug = (message) => logger?.warn?.(String(message))
  }
  ctx.effect(() => ctx.skills.registerProvider(() => definePptMasterSkill(options)))
}
