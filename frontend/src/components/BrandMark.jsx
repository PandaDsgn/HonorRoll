// Two-tone wordmark — "Honor" in the neutral heading color (adapts per
// theme: near-black on light, white on dark), "Roll" in gold. Shared by
// every page's nav wordmark and the landing hero heading.
export default function BrandMark() {
  return (
    <>
      <img src={`${import.meta.env.BASE_URL}favicon.png`} alt="" className="brand-logo" />
      <span className="brand-text">
        <span className="brand-honor">Honor</span>
        <span className="brand-roll">Roll</span>
      </span>
    </>
  );
}
