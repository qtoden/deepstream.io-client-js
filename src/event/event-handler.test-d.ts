import { expectAssignable, expectType } from 'tsd'
import type EventHandler from './event-handler.js'

declare const events: EventHandler

events.once('event', (name, data) => {
  expectType<string>(name)
  expectType<unknown>(data)
})

expectAssignable<(() => void) | undefined>(events.provide('pattern*', () => {}))
