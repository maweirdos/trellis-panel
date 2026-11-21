import type { JSX, ReactNode } from 'react'
import { Check } from 'lucide-react'
import { BrandMark } from '../my/BrandMark'
import { BrandWordmark } from '../my/BrandWordmark'
import './onboarding-shell.css'

export interface OnboardingStep {
  id: string
  label: string
  description?: string
  completed?: boolean
}

export interface OnboardingShellProps {
  steps: readonly OnboardingStep[]
  currentStepId: string
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  footer: ReactNode
  sidebarFooter?: ReactNode
  progressLabel?: string
}

export function OnboardingShell({
  steps,
  currentStepId,
  title,
  description,
  children,
  footer,
  sidebarFooter,
  progressLabel = '设置进度',
}: OnboardingShellProps): JSX.Element {
  return (
    <div className="onboarding-shell">
      <div className="onboarding-shell__card">
        <aside className="onboarding-shell__sidebar">
          <div className="onboarding-shell__brand" role="img" aria-label="Crux">
            <BrandMark size={28} />
            <BrandWordmark width={88} />
          </div>
          <nav className="onboarding-shell__progress" aria-label={progressLabel}>
            <ol className="onboarding-shell__steps">
              {steps.map((step, index) => {
                const current = step.id === currentStepId
                return (
                  <li className={`onboarding-shell__step${current ? ' is-current' : ''}${step.completed ? ' is-complete' : ''}`}
                    aria-current={current ? 'step' : undefined} key={step.id}>
                    <span className="onboarding-shell__step-marker" aria-hidden="true">
                      {step.completed && !current ? <Check size={15} strokeWidth={2} /> : index + 1}
                    </span>
                    <span className="onboarding-shell__step-copy">
                      <span className="onboarding-shell__step-label">{step.label}</span>
                      {step.description && <span className="onboarding-shell__step-description">{step.description}</span>}
                      {step.completed && <span className="onboarding-shell__sr-only">（已完成）</span>}
                    </span>
                  </li>
                )
              })}
            </ol>
          </nav>
          {sidebarFooter && <div className="onboarding-shell__sidebar-footer">{sidebarFooter}</div>}
        </aside>
        <section className="onboarding-shell__main">
          <div className="onboarding-shell__body my-scrollbar">
            <div className="onboarding-shell__content">
              <header className="onboarding-shell__heading">
                <h1>{title}</h1>
                {description && <div className="onboarding-shell__description">{description}</div>}
              </header>
              <div className="onboarding-shell__children">{children}</div>
            </div>
          </div>
          <footer className="onboarding-shell__footer">{footer}</footer>
        </section>
      </div>
    </div>
  )
}
