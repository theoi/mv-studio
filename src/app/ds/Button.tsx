import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Tooltip } from './Tooltip.tsx'
import styles from './Button.module.css'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle'
type Size = 'sm' | 'md' | 'lg' | 'xl'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  icon?: ReactNode
  iconEnd?: ReactNode
  block?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, iconEnd, block, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      data-variant={variant}
      className={[styles.button, styles[variant], styles[size], block && styles.block, className]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {icon && <span className={styles.icon}>{icon}</span>}
      {children && <span className={styles.label}>{children}</span>}
      {iconEnd && <span className={styles.icon}>{iconEnd}</span>}
    </button>
  )
})

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  shortcut?: string
  size?: 'xs' | 'sm' | 'md' | 'lg'
  active?: boolean
  tooltipSide?: 'top' | 'bottom' | 'left' | 'right'
  variant?: 'ghost' | 'secondary'
  children: ReactNode
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    shortcut,
    size = 'md',
    active,
    tooltipSide = 'bottom',
    variant = 'ghost',
    className,
    children,
    type = 'button',
    ...rest
  },
  ref,
) {
  return (
    <Tooltip label={label} shortcut={shortcut} side={tooltipSide}>
      <button
        ref={ref}
        type={type}
        aria-label={label}
        aria-pressed={active === undefined ? undefined : active}
        className={[
          styles.iconButton,
          styles[`icon-${size}`],
          styles[`icon-${variant}`],
          active && styles.active,
          className,
        ]
          .filter(Boolean)
          .join(' ')}
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
  )
})
