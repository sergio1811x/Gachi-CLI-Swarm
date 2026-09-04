/**
 * Full-viewport loader shown while the app bootstraps (initial UI session +
 * first workspace list fetch) — most visibly on a hard page refresh, where
 * the sidebar/content would otherwise flash empty for a moment.
 */
export const AppBootLoader = () => (
  <div
    className="fixed inset-0 z-[999] flex items-center justify-center"
    style={{ background: 'var(--bg-crust)' }}
    data-testid="app-boot-loader"
  >
    <img src="/loader.gif" alt="" width={96} height={96} />
  </div>
)
