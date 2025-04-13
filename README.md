# Update Patrons

This GitHub Action updates a list of supporters in specified files by fetching data from [Meza's supporters][kofi]. 
It replaces content between specified markers with the names of supporters, commits the changes, 
and creates a pull request if needed.

## Features

- Fetches supporter data from [Meza's supporters][kofi].
- Updates specified files with supporter names between configurable markers.
- Creates a new branch and commits changes.
- Opens a pull request if changes are detected.

## Inputs

| Name                      | Required | Default                         | Description                                                        |
|---------------------------|----------|---------------------------------|--------------------------------------------------------------------|
| `files-to-update`         | No       | `["README.md"]`                 | List of files to update with supporter names.                      |
| `fail-on-missing-markers` | No       | `true`                          | Whether to fail if markers are missing or misordered in the files. |
| `start-marker`            | No       | `<!-- marker:patrons-start -->` | Start marker for the replacement section.                          |
| `end-marker`              | No       | `<!-- marker:patrons-end -->`   | End marker for the replacement section.                            |
| `git-email`               | No       | `actions@github.com`            | Email address for Git configuration.                               |

## Outputs

This action does not produce any outputs.

## Usage

Below is an example workflow that uses this action:

```yaml
name: Update Supporters List

on:
  schedule:
    - cron: "0 0 * * 1" # Runs every Monday at midnight
  workflow_dispatch:

jobs:
  update-supporters:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v3

      - name: Update supporters list
        uses: meza/action-patrons@v1
        with:
          files-to-update: |
            - README.md
```

## JSON Data Format

The JSON file fetched from the URL should have the following structure:

```json
{
  "tiers": [
    {
      "name": "Tier 1",
      "members": [
        { "name": "Supporter A" },
        { "name": "Supporter B" }
      ]
    },
    {
      "name": "Tier 2",
      "members": [
        { "name": "Supporter C" },
        { "name": "Supporter D" }
      ]
    }
  ]
}
```

The action will use the members of the last tier in the JSON file to update the files.

## Notes

- Ensure the markers (`start-marker` and `end-marker`) are present in the files to be updated.
- If no changes are detected, the action will skip creating a pull request.
- The action assumes the repository's default branch is `main`.

## License

This project is licensed under the [MIT License](LICENSE).

[kofi]: https://ko-fi.com/meza
