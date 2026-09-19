# File upload workflow

Treat filename, metadata and bytes as attacker-controlled.

Validate server-side:
- maximum size before unbounded buffering where possible
- allowed content/MIME using trusted inspection when risk warrants it, not extension alone
- safe generated storage keys rather than user-controlled paths
- authorization for upload, read and delete operations
- storage visibility and signed/public URL policy
- archive extraction paths and executable/script content where relevant

Design cleanup for abandoned multipart uploads, replaced files and failed transactions. Decide whether metadata/database state or object storage is authoritative and how partial failure is reconciled.

For image processing, bound dimensions/resource use and strip dangerous metadata when required.

Verification should test oversize, disallowed type, traversal names, duplicate/retry behavior, unauthorized access, cleanup after failure and successful download/render of a valid file.
