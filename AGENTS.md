# Project operating notes

Before making changes or deploying this repository, read [docs/project-memory.md](docs/project-memory.md).

Critical defaults:

- The user's default deployment target is the formal production site, not staging. Deploy to staging only when explicitly requested.
- The user has confirmed the current players/accounts are test accounts and requests direct deployment. Do not block a requested production deployment only because test clients are connected; expect that restarting the relay can disconnect them.
- SSH uses the custom-named RSA identity at `C:\Users\z\.ssh\numeral_lord_deploy_rsa`. Specify it explicitly with `-i` and `-o IdentitiesOnly=yes`; default SSH key discovery does not find it. Never display, copy into the repo, or otherwise expose private-key contents.
- For completed implementation/fix tasks, the user's default is to commit, push to `origin/main`, and deploy to formal production after validation. Do this without waiting for a separate reminder unless the user explicitly says not to deploy, to keep the work local, or only asks for diagnosis/review. Stage only files belonging to the task; preserve unrelated dirty and untracked files.
