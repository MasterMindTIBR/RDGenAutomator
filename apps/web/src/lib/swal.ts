import Swal from 'sweetalert2';

export type ImportCategory = 'server' | 'preset' | 'branding';

const baseTheme = {
  background: 'var(--panel)',
  color: 'var(--foreground)',
  buttonsStyling: false,
  customClass: {
    popup: 'swal-popup',
    title: 'swal-title',
    htmlContainer: 'swal-html',
    confirmButton: 'swal-confirm',
    cancelButton: 'swal-cancel',
    actions: 'swal-actions',
  },
};

export async function confirmSwal(
  title: string,
  options?: { text?: string; confirmText?: string; cancelText?: string; danger?: boolean }
): Promise<boolean> {
  const result = await Swal.fire({
    ...baseTheme,
    title,
    text: options?.text,
    icon: options?.danger ? 'warning' : 'question',
    showCancelButton: true,
    confirmButtonText: options?.confirmText ?? 'Confirmar',
    cancelButtonText: options?.cancelText ?? 'Cancelar',
    customClass: {
      ...baseTheme.customClass,
      confirmButton: options?.danger ? 'swal-confirm swal-confirm-danger' : 'swal-confirm',
    },
  });
  return result.isConfirmed;
}

const importLabels: Record<ImportCategory, string> = { server: 'Servidor', preset: 'Preset', branding: 'Branding' };

/** Asks which additional categories of a JSON import to bring in; null means "import only here". */
export async function chooseExtraImports(detected: ImportCategory[]): Promise<ImportCategory[] | null> {
  if (detected.length === 0) return [];
  const options = detected.map((category) =>
    `<label class="swal-import-option"><input type="checkbox" value="${category}" checked class="swal-import-opt"><span>${importLabels[category]}</span></label>`
  ).join('');
  const result = await Swal.fire({
    ...baseTheme,
    title: 'Dados adicionais detectados',
    html: `<div style="margin-bottom:12px">Este arquivo também contém outras categorias. Marque as que deseja importar:</div>${options}`,
    showCancelButton: true,
    confirmButtonText: 'Importar selecionados',
    cancelButtonText: 'Importar apenas aqui',
    preConfirm: () => {
      const popup = Swal.getPopup();
      if (!popup) return [];
      return Array.from(popup.querySelectorAll<HTMLInputElement>('input.swal-import-opt:checked')).map((el) => el.value as ImportCategory);
    },
  });
  if (!result.isConfirmed) return null;
  return Array.isArray(result.value) ? (result.value as ImportCategory[]) : [];
}
