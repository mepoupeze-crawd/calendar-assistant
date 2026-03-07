/**
 * Google Contacts Lookup via People API
 * Requires scope: https://www.googleapis.com/auth/contacts.readonly
 *
 * To add this scope, re-run: npm run authorize
 */

import { google } from 'googleapis';
import { getGoogleAuth } from './google-auth';

export interface Contact {
  name: string;
  email: string;
}

/**
 * Search the authenticated user's contacts by name.
 * Returns all contacts with at least one email address.
 * Returns { contacts: [], error: true } on API error (caller shows distinct message).
 * Returns { contacts: [], error: false } when no match is found.
 */
export async function lookupContactsByName(name: string): Promise<{ contacts: Contact[]; error: boolean }> {
  try {
    const auth = getGoogleAuth();
    const people = google.people({ version: 'v1', auth });

    const res = await people.people.searchContacts({
      query: name,
      readMask: 'names,emailAddresses',
      pageSize: 10,
    });

    const results: Contact[] = [];
    const seenEmails = new Set<string>();

    for (const result of res.data.results ?? []) {
      const person = result.person;
      if (!person) continue;

      const displayName =
        person.names?.find(n => n.metadata?.primary)?.displayName ??
        person.names?.[0]?.displayName ??
        name;

      const email =
        person.emailAddresses?.find(e => e.metadata?.primary)?.value ??
        person.emailAddresses?.[0]?.value;

      if (email && !seenEmails.has(email)) {
        seenEmails.add(email);
        results.push({ name: displayName, email });
      }
    }

    console.log(`[Contacts] "${name}" → ${results.length} result(s)`);
    return { contacts: results, error: false };
  } catch (err) {
    console.warn(
      '[Contacts] Lookup failed (re-run `npm run authorize` to add contacts scope):',
      err instanceof Error ? err.message : String(err)
    );
    return { contacts: [], error: true };
  }
}
