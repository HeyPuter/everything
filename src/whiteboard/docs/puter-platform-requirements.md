# Puter platform requirements for enterprise identity

Whiteboard uses Puter.js as its only backend. Most enterprise controls are implemented inside the organization's Puter worker and are available today. A few identity controls belong to the Puter account platform, because they concern how a person signs in to Puter rather than what they can do in Whiteboard. This document lists what the platform must provide and how Whiteboard uses it.

## Available in Whiteboard today

| Capability                          | How it works                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in with Google Workspace       | Puter's sign-in offers Sign in with Google (OpenID Connect), so people use their Google Workspace accounts, under the Workspace's own sign-in policies, such as 2-Step Verification, when they sign in. The Puter session that follows is Puter's.                                                                                  |
| Organization with unlimited members | Every organization is one Puter worker owned by the account owner; membership is not limited by seats.                                                                                                                                                                                                                              |
| Domain verification and capture     | Members verify a work email with a one-time code sent by the organization's worker. With domain capture on, verified addresses in the organization's domains join automatically.                                                                                                                                                    |
| Provisioning and deprovisioning     | SCIM 2.0 (`/scim/v2/Users`, `/scim/v2/Groups`), a [Google Workspace directory sync](google-workspace/README.md) for it, and a documented REST API authenticated with scoped API keys. Provisioned people are pending until they sign in and verify the same email; deactivation ends their access and live sessions on every board. |
| Roles                               | Organization roles (owner, administrator, member, guest) and board roles (owner, facilitator, editor, commenter, viewer, plus guest memberships with expiry), enforced by the worker.                                                                                                                                               |
| Audit and SIEM                      | Audit log with export to Microsoft Sentinel (Logs Ingestion API) or any HTTPS endpoint, pull API, webhooks, and alerts.                                                                                                                                                                                                             |
| AI administration                   | The organization's worker runs every AI request for members, so turning features off is enforced server-side.                                                                                                                                                                                                                       |

## Required from the Puter account platform

### 1. SAML 2.0 single sign-on with Google Workspace

Sign in with Google already lets people use their Google Workspace accounts; it is not tied to the organization, so a person can still choose another way to sign in to Puter, and the worker still verifies their work email with a code.

- Puter accounts must support signing in through a customer's SAML identity provider (Google Workspace as a custom SAML app), with IdP-initiated and SP-initiated flows.
- The platform must bind an organization's verified domains to its IdP, so people with those addresses are redirected to Google Workspace instead of entering a Puter password.
- Tokens issued after SAML sign-in should carry the verified email and an `idp` claim, so the organization's worker can trust the email without its own verification code.

How Whiteboard uses it: the verification-code flow remains as a fallback; when the claim is present, the worker links the account to its SCIM record and applies domain capture immediately.

### 2. Multifactor authentication

- Puter enforces multifactor authentication when people sign in to their Puter accounts, so Whiteboard, which uses those accounts, needs no second factor of its own.

### 3. Account provisioning by the identity provider

- Today SCIM creates pending organization records; the person creates or uses a Puter account and verifies their email to activate them.
- The platform should allow an organization owner to provision Puter accounts directly for their verified domains (the Teams feature provides seats but is capped at 40 per paid owner), so SCIM can create a ready-to-use account and deprovisioning can disable it at the platform level.

### 4. Domain ownership verification

- The platform should verify domain ownership (for example a DNS TXT record) before an organization can capture a domain, so domain capture is backed by proof of ownership rather than by email verification alone.

### 5. Service commitments

- Published availability targets and status reporting for the Puter API, workers, KV, file storage, and peer relays, which Whiteboard depends on for shared boards.

## Summary

| Capability                     | Status                                                                   |
| ------------------------------ | ------------------------------------------------------------------------ |
| Sign-in with Google Workspace  | Available (Sign in with Google)                                          |
| SAML SSO with Google Workspace | Requires item 1                                                          |
| Domain verification or capture | Available (email verification and domain capture); item 4 strengthens it |
| Enforce MFA                    | Available (enforced by Puter sign-in)                                    |
| SCIM or documented APIs        | Available                                                                |
| Audit logs to Azure Sentinel   | Available                                                                |
