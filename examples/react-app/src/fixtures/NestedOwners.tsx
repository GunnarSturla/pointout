// Fixture: a nested owner chain, three deep, plus an element whose owner is two
// levels above where it renders.
//
// `<h3>` is written by CardHeading, which is written by ArticleCard, which is
// written by ArticleList. The badge is a different shape of the same problem:
// ArticleList creates the element and ArticleCard only places it, so the line a
// developer wants changed is ArticleList's, not ArticleCard's. React's notion of
// ownership gets this right and a DOM ancestry walk does not.

import type { ReactNode } from 'react'

const articles = [
  { id: 'a1', title: 'Picking an element', badge: 'draft' },
  { id: 'a2', title: 'Writing the note', badge: 'review' },
]

function CardHeading({ children }: { children: ReactNode }) {
  return <h3 className="card-heading">{children}</h3>
}

function ArticleCard({ title, badge }: { title: string; badge: ReactNode }) {
  return (
    <article className="card" data-fixture="nested-owners-card">
      <CardHeading>{title}</CardHeading>
      <p className="card-body">
        The badge beside this line was created two owners up and only placed here. {badge}
      </p>
    </article>
  )
}

function ArticleList() {
  return articles.map((article) => (
    <ArticleCard
      key={article.id}
      title={article.title}
      badge={
        <span className="badge" data-fixture="passed-down-badge">
          {article.badge}
        </span>
      }
    />
  ))
}

export function NestedOwners() {
  return (
    <section className="fixture" data-fixture="nested-owners">
      <h2>Nested owner chain</h2>
      <ArticleList />
    </section>
  )
}
