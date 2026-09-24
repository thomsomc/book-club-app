import { useState, useEffect } from 'react'

export default function ScoreStepper({ value, onChange, disabled }) {
  const [inputValue, setInputValue] = useState(value.toFixed(1))

  // Keep input in sync when value changes externally (e.g. after vote reload)
  useEffect(() => {
    setInputValue(value.toFixed(1))
  }, [value])

  const decrement = () => onChange(Math.max(0, Math.round((value - 0.1) * 10) / 10))
  const increment = () => onChange(Math.min(5, Math.round((value + 0.1) * 10) / 10))

  function handleInputChange(e) {
    setInputValue(e.target.value)
  }

  function handleInputBlur() {
    const parsed = parseFloat(inputValue)
    if (!isNaN(parsed)) {
      const clamped = Math.min(5, Math.max(0, Math.round(parsed * 10) / 10))
      onChange(clamped)
      setInputValue(clamped.toFixed(1))
    } else {
      setInputValue(value.toFixed(1))
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') e.target.blur()
    if (e.key === 'ArrowUp') { e.preventDefault(); increment() }
    if (e.key === 'ArrowDown') { e.preventDefault(); decrement() }
  }

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={decrement}
        disabled={disabled || value <= 0}
        className="w-8 h-8 flex items-center justify-center bg-gray-700 rounded-lg hover:bg-gray-600 disabled:opacity-40 font-bold text-lg leading-none"
      >
        −
      </button>
      <input
        type="number"
        value={inputValue}
        onChange={handleInputChange}
        onBlur={handleInputBlur}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        step="0.1"
        min="0"
        max="5"
        className="w-16 text-center font-mono tabular-nums text-lg bg-gray-800 border border-gray-700 rounded-lg px-1 py-0.5 focus:outline-none focus:border-indigo-500 disabled:opacity-40 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      />
      <button
        type="button"
        onClick={increment}
        disabled={disabled || value >= 5}
        className="w-8 h-8 flex items-center justify-center bg-gray-700 rounded-lg hover:bg-gray-600 disabled:opacity-40 font-bold text-lg leading-none"
      >
        +
      </button>
    </div>
  )
}
