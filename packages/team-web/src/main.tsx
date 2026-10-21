import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import '../../../src/renderer/src/my/my-tokens.css'
import './style.css'

const root = document.getElementById('root')
if (!root) throw Error('Missing application root')
createRoot(root).render(<React.StrictMode><App /></React.StrictMode>)
