# Images

The default home for wiki images. AVIF puts a 1600px screenshot at 15-30KB, so a hundred
of them is about 3MB across both git histories - not worth hosting elsewhere to avoid.

Prepare them with the helper rather than by hand; it sizes, encodes, writes the WebP
fallback beside the AVIF, and prints the block to paste:

    python scripts/prep-image.py shot.png rarity-stats/anvil-ui --alt "The Heavy Anvil menu"

Nothing to declare anywhere - dimensions are read from the file at build time and the
fallback is found on disk.

## What does not belong here

Anything still large after encoding: animated captures, video, bulk texture dumps. Those
go to the assets repo with `--external`. A GIF is routinely 20x an AVIF still, and that
is the kind of file that makes a repo unpleasant to clone.

Rough line: over a few hundred KB, put it outside.
