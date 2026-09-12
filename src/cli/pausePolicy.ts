/**
 * The manual-image pause policy shared by the run/resume composition roots.
 *
 * Per `21-cost-budget-modes-human-in-loop.md` and
 * `20-product-reselling-architecture.md`, when a run is configured with
 * `imageSource: 'manual'` it pauses in `awaiting_assets` as soon as the image
 * plan exists but no files have been attached yet. The human drops the images
 * in via `attach-images --run-id <id> --dir <path>`, which returns the run to
 * `running`; the resume then continues. For any other image source the policy
 * never pauses. The decision lives at the composition root — module code never
 * branches on the profile.
 */

import type { Config } from '@/core/types.js';
import type { PipelineState, PipelineStatus } from '@/core/state.js';

export function createPausePolicy(
  config: Config,
): (state: PipelineState) => PipelineStatus | undefined {
  return (state) => {
    if (
      config.imageSource === 'manual' &&
      state.images?.plan !== undefined &&
      state.images?.staged === undefined
    ) {
      return 'awaiting_assets';
    }
    return undefined;
  };
}
