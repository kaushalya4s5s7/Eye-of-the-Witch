# media/

AI-generated video clips for the left ritual panel. Empty until build step 3.

Expected files (referenced from `src/` as ES asset imports at step 3):

| file            | plays on            | notes                                  |
| --------------- | ------------------- | -------------------------------------- |
| `concoction.*`  | search/scoring loop | looping background while candidates score |
| `success.*`     | `Attested`          | plays once, then holds last frame       |
| `failure.*`     | `NoMatchFound`      | distinct from the `Failed` error state  |

Use `.mp4` (H.264) or `.webm`. Keep clips short and loopable where noted.
Until they exist, the left panel uses labeled colored placeholder boxes.
