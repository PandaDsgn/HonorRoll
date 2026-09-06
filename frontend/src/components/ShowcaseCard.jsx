// Seamless, non-interactive product showcase — three frames take turns via
// a pure-CSS opacity loop (see .showcase-frame-1/2/3 keyframes in
// index.css), each one a real (fake) snapshot of the product rather than
// an illustration of it. Shared by Home's hero and the auth pages' side
// panel, which is why this lives as its own component rather than inline
// markup in either.
export default function ShowcaseCard() {
  return (
    <div className="showcase code-window-card" aria-hidden="true">
      <div className="showcase-frame showcase-frame-1">
        <div className="showcase-label">Assignments</div>
        <div className="showcase-scan">
          <div className="showcase-scan-doc">
            <span className="showcase-scan-corner tl" />
            <span className="showcase-scan-corner tr" />
            <span className="showcase-scan-corner bl" />
            <span className="showcase-scan-corner br" />
            <div className="showcase-scan-lines">
              <span style={{ width: '78%' }} />
              <span style={{ width: '92%' }} />
              <span style={{ width: '65%' }} />
              <span style={{ width: '85%' }} />
              <span style={{ width: '40%' }} />
            </div>
          </div>
          <div className="hero-mock-console">
            <span className="console-out">Scan captured, ready to submit</span>
          </div>
        </div>
      </div>

      <div className="showcase-frame showcase-frame-2">
        <div className="showcase-label">Timed exams</div>
        <div className="showcase-exam">
          <div className="showcase-exam-row">
            <span>Question 4 of 12</span>
            <span className="showcase-timer">18:42</span>
          </div>
          <div className="showcase-exam-q">A binary search tree has 31 nodes. What is the maximum possible height?</div>
          <div className="showcase-exam-options">
            <div className="showcase-exam-opt">30</div>
            <div className="showcase-exam-opt showcase-exam-opt-selected">5</div>
            <div className="showcase-exam-opt">15</div>
          </div>
        </div>
      </div>

      <div className="showcase-frame showcase-frame-3">
        <div className="showcase-label">Code sandbox</div>
        <div className="hero-mock-tab">binary_search.go</div>
        <pre className="hero-mock-code">{`func binarySearch(nums []int, target int) int {
    lo, hi := 0, len(nums)-1
    for lo <= hi {
        mid := (lo + hi) / 2
        if nums[mid] == target {
            return mid
        } else if nums[mid] < target {
            lo = mid + 1
        } else {
            hi = mid - 1
        }
    }
    return -1
}
`}</pre>
      </div>
    </div>
  );
}
