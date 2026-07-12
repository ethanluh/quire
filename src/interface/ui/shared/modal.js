/**
 * Modal stack manager for keyboard accessibility and focus management.
 * Handles focus trapping, Escape key navigation, and backdrop click-to-close.
 * Supports multiple modal stacks (one per page) via separate instances.
 */

class ModalStack {
	constructor() {
		this.stack = [];
		this.previousFocus = null;
		this.keydownHandler = (event) => this.handleKeyDown(event);
	}

	/**
	 * Open a modal with focus management and keyboard navigation.
	 * @param {Element} backdropEl - The modal-backdrop element
	 * @param {Object} options - Configuration options
	 * @param {Function} options.onClose - Called when modal closes
	 */
	open(backdropEl, options = {}) {
		options = options || {};

		// Already open — silently no-op as per the spec ("silently return false if already open")
		if (this.stack.some(m => m.backdropEl === backdropEl)) {
			return;
		}

		// Find the dialog element inside the backdrop
		const dialogEl = backdropEl.querySelector('[role="dialog"]');
		if (!dialogEl) {
			console.error('Modal backdrop must contain an element with role="dialog"', backdropEl);
			return;
		}

		// Save current focus so we can restore it on close
		const trigger = document.activeElement;

		// Add to stack
		const modalEntry = {
			backdropEl,
			dialogEl,
			onClose: options.onClose,
			trigger,
		};
		this.stack.push(modalEntry);

		// Show the backdrop
		backdropEl.style.display = 'flex';

		// Lock body scroll if this is the first modal
		if (this.stack.length === 1) {
			document.body.classList.add('modal-open');
			document.addEventListener('keydown', this.keydownHandler);
		}

		// Set up backdrop click handler (close on backdrop click, not on dialog click)
		const backdropClickHandler = (event) => {
			if (event.target === backdropEl) {
				this.close(backdropEl);
			}
		};
		modalEntry.backdropClickHandler = backdropClickHandler;
		backdropEl.addEventListener('click', backdropClickHandler);

		// Focus the dialog or first focusable element inside it
		this.focusDialog(dialogEl);
	}

	/**
	 * Close the topmost modal (or specific modal if backdropEl provided).
	 * @param {Element} backdropEl - Optional: specific modal to close. If not provided, closes topmost.
	 */
	close(backdropEl) {
		if (this.stack.length === 0) return;

		// If specific modal specified, find and remove it; otherwise pop the top
		let modalEntry;
		if (backdropEl) {
			const index = this.stack.findIndex(m => m.backdropEl === backdropEl);
			if (index === -1) return;
			modalEntry = this.stack.splice(index, 1)[0];
		} else {
			modalEntry = this.stack.pop();
			backdropEl = modalEntry.backdropEl;
		}

		// Remove event listeners
		if (modalEntry.backdropClickHandler) {
			backdropEl.removeEventListener('click', modalEntry.backdropClickHandler);
		}

		// Hide the backdrop
		backdropEl.style.display = 'none';

		// Call onClose callback if provided
		if (modalEntry.onClose) {
			modalEntry.onClose();
		}

		// Unlock body scroll and remove keydown handler if stack is empty
		if (this.stack.length === 0) {
			document.body.classList.remove('modal-open');
			document.removeEventListener('keydown', this.keydownHandler);
		}

		// Restore focus to what triggered the modal
		if (modalEntry.trigger && modalEntry.trigger.focus) {
			modalEntry.trigger.focus();
		}
	}

	/**
	 * Handle keyboard events for the modal stack.
	 * - Escape: closes topmost modal
	 * - Tab: trapped within topmost dialog
	 */
	handleKeyDown = (event) => {
		if (this.stack.length === 0) return;

		const topModal = this.stack[this.stack.length - 1];
		const dialogEl = topModal.dialogEl;

		// Escape key closes the topmost modal
		if (event.key === 'Escape') {
			event.preventDefault();
			this.close();
			return;
		}

		// Tab key: trap focus within the dialog
		if (event.key === 'Tab') {
			this.handleTabKey(event, dialogEl);
		}
	};

	/**
	 * Trap Tab key focus within the dialog.
	 * - Shift+Tab on first focusable: focus last focusable
	 * - Tab on last focusable: focus first focusable
	 */
	handleTabKey(event, dialogEl) {
		const focusableElements = Array.from(
			dialogEl.querySelectorAll(
				'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
			)
		).filter(el => !el.hasAttribute('disabled') && el.offsetParent !== null);

		if (focusableElements.length === 0) return;

		const currentFocus = document.activeElement;
		const currentIndex = focusableElements.indexOf(currentFocus);

		if (event.shiftKey) {
			// Shift+Tab: move backward
			if (currentIndex <= 0) {
				event.preventDefault();
				focusableElements[focusableElements.length - 1].focus();
			}
		} else {
			// Tab: move forward
			if (currentIndex >= focusableElements.length - 1) {
				event.preventDefault();
				focusableElements[0].focus();
			}
		}
	}

	/**
	 * Focus the dialog or the first focusable element inside it.
	 */
	focusDialog(dialogEl) {
		// Try to find a close button or a primary action button to focus
		const closeBtn = dialogEl.querySelector('[aria-label*="lose"], [aria-label*="ancel"]');
		const focusableElements = Array.from(
			dialogEl.querySelectorAll(
				'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
			)
		).filter(el => el.offsetParent !== null);

		if (closeBtn && closeBtn.offsetParent !== null) {
			closeBtn.focus();
		} else if (focusableElements.length > 0) {
			focusableElements[0].focus();
		} else {
			// Fall back to focusing the dialog itself
			dialogEl.focus();
		}
	}
}

// Export a single instance for both pages to use
const modalManager = new ModalStack();
