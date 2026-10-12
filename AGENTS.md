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
- Point investment goes only through the invest_points database function; the client never writes character_attributes.points. Why: the point balance, the caps and the derived maximum must change atomically and be checked server-side.
- Master identity comes from the master_emails table matched against the authenticated email; the client never chooses a role. Why: nobody can promote themselves through the UI or manual API calls.
