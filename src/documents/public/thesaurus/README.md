# Thesaurus data

`en.json` is generated from the WordNet 3.1 database (Princeton University) by
`tools/generate-thesaurus.mjs`. It is fetched only when the Thesaurus pane is first used.

## Source

- WordNet 3.1 dictionary files, `wn3.1.dict.tar.gz` from https://wordnetcode.princeton.edu/wn3.1.dict.tar.gz,
  sha256 `3f7d8be8ef6ecc7167d39b10d66954ec734280b5bdcd57f7d9eafe429d11c22a`.
- The `data.*` and `index.*` files are byte-identical to those in the npm package `wordnet-db@3.1.14`
  (https://registry.npmjs.org/wordnet-db/-/wordnet-db-3.1.14.tgz, sha256
  `9b93831ae01771d02f360c1ebf3fe415ed2426a31f2201cb0943025c7403e79a`), which does not include the
  `*.exc` irregular-form lists; those come from the tarball above.
- License: the WordNet License, reproduced verbatim (from the database file headers) in
  `LICENSE-WordNet.txt`. It permits use, copying, modification and distribution provided the
  copyright notice, statements and disclaimer accompany all copies.

## Generation

```
tar -xzf wn3.1.dict.tar.gz        # in a scratch directory
node tools/generate-thesaurus.mjs <scratch>/dict
```

Output (deterministic): 31,456 entries, 2,877,643 bytes, sha256
`583c157505cd770d1cfe777ea577548c0516ba46fc3ea5de11819c939532af8b` (recorded in
`tools/check-licenses.mjs`).

## What is kept

- Single-word (optionally hyphenated) lemmas only; nouns that never occur in the sense-tagged
  corpus are left out, and for each part of speech only the tagged senses (at least one) are kept,
  at most 4 per part of speech and 6 per word.
- Per sense: the definition up to the first example, shortened to about 64 characters; up to 10
  synonyms (the synset's other words, single words first, plus nearby head/satellite adjectives and
  "also see" words for adjectives and verbs); antonyms from antonym pointers, with adjective
  satellites taking their head's antonyms.
- Irregular forms (`noun.exc`, `verb.exc`, `adj.exc`, `adv.exc`) whose base form is an entry.
