// Review and collaboration: the Comments panel and Comment tool (comments
// pinned to points or regions, in any document), Invite to Edit (a shared
// document edited live by several people) and Share for Review (a link that
// opens a lightweight review view). Everything heavy — Yjs, the room client,
// peer links, dialogs — loads on first use; see docs/collaboration.md.
import type { Editor } from '../../editor';
import { registerCommand, registerOverlay, registerPanel, registerTool } from '../../app/registry';
import { lazy, lazyPanel, lazyRun, lazyTool } from '../../app/lazy';
import { parseLink } from '../../collab/protocol';
import { commentsOf, commentsOverlay, dropLocalComments, sharedOf, view } from './state';

const share = lazy(() => import('./share'));
const tool = lazy(async () => (await import('./comment-tool')).commentTool);
const panel = lazy(async () => (await import('./comments-panel')).commentsPanel);

const owns = (e: Editor) => {
  const sh = sharedOf(e.session);
  return !sh || sh.role === 'owner';
};

export function installCollab(e: Editor) {
  registerOverlay('comments', commentsOverlay);
  registerOverlay('collab-presence', (ed) => sharedOf(ed.session)?.overlay(ed) ?? '');
  registerTool(lazyTool({ id: 'comment', label: 'Comment Tool', key: 'I', icon: 'comment', group: 'eyedropper' }, tool));
  registerPanel(
    lazyPanel(
      {
        id: 'comments',
        title: 'Comments',
        icon: 'comment',
        location: 'strip',
        hidden: true,
        menu: () => ['comments.new', '-', 'view.show-comments', '-', 'file.share-for-review'],
      },
      panel,
    ),
  );
  registerCommand(
    {
      id: 'file.invite-to-edit',
      label: 'Invite to Edit…',
      description: 'Share this document so others can edit it with you live',
      enabled: (ed) => ed.hasDocument && owns(ed) && !sharedOf(ed.session)?.review,
      recordable: false,
      ...lazyRun(share, (m, ed) => m.inviteToEdit(ed)),
    },
    {
      id: 'file.share-for-review',
      label: 'Share for Review…',
      description: 'Create a link that opens this document for viewing and comments',
      enabled: (ed) => ed.hasDocument && owns(ed) && !sharedOf(ed.session)?.review,
      recordable: false,
      ...lazyRun(share, (m, ed) => m.shareForReview(ed)),
    },
    {
      id: 'file.stop-sharing',
      label: 'Stop Sharing…',
      description: 'End sharing for everyone; this tab keeps a local copy',
      enabled: (ed) => sharedOf(ed.session)?.role === 'owner',
      recordable: false,
      ...lazyRun(share, (m, ed) => m.stopSharing(ed)),
    },
    {
      id: 'comments.new',
      label: 'New Comment',
      description: 'Choose the Comment tool: click to pin a comment, drag to comment on a region',
      enabled: (ed) => ed.hasDocument && commentsOf(ed).canComment(),
      recordable: false,
      run: (ed) => {
        ed.setTool('comment');
        if (!ed.dock.isVisible('comments')) ed.dock.show('comments');
      },
    },
    {
      id: 'view.show-comments',
      label: 'Comments',
      checked: () => !view.hidden,
      recordable: false,
      run: (ed) => {
        view.hidden = !view.hidden;
        ed.overlay();
      },
    },
  );
  e.closeHooks.push((s) => dropLocalComments(s));
  // Opening an invitation or review link (Photo Studio was opened with one,
  // or one was pasted into the address bar).
  const fromLink = () => {
    let link;
    try {
      link = parseLink(location.href);
    } catch (error) {
      e.message(error instanceof Error ? error.message : String(error));
      return;
    }
    if (!link) return;
    // The invitation stays out of the address bar (and browser history) once read.
    history.replaceState(null, '', location.pathname + location.search);
    void e.run(async () => (await share()).openLink(e, link));
  };
  e.whenReady(() => setTimeout(fromLink, 0));
  window.addEventListener('hashchange', fromLink);
}
