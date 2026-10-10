<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Permissions are enforced by database RLS (has_role master vs owner_id); the client talks to the database directly. Why: players can't bypass rules via manual API calls.
- Attributes live in attribute_definitions + character_attributes rows. Why: new attributes need only a new definition row, no schema change.
