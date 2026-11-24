# Glossary

**Authority** — The server's state for a player. It is the only state that counts
for interactions. Clients draw ahead of it, or behind it, but correct towards it.

**Local prediction** — Your own player, run ahead of the authority one physics step
at a time, so movement responds without waiting for a round trip. Inputs the server
has not acknowledged are replayed on each authoritative state. Lives in
`client/src/local-prediction.ts`.

**Partner playback** — The other player, drawn a little behind their newest state
on their own step timeline, so jitter in delivery doesn't show as uneven movement.
Lives in `client/src/partner-playback.ts`.
