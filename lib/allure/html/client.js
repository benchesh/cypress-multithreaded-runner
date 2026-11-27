// Runs inside the generated Allure report (see lib/allure/html/reportHtml.js)

const handleOpenCloseAllButtons = () => {
    document.querySelector('#cmr-open-all').classList.remove('cmr-disabled');
    document.querySelector('#cmr-close-all').classList.remove('cmr-disabled');

    let visibleDropdowns=0;
    let visibleDropdownsOpen=0;
    let visibleDropdownsClosed=0;

    document.querySelectorAll('.cmr-all-logs .cmr-pre-heading').forEach((heading)=>{
        if (heading.getBoundingClientRect().width > 0) visibleDropdowns++;
    });

    document.querySelectorAll('.cmr-all-logs .cmr-pre-heading.cmr-pre-heading-active').forEach((heading)=>{
        if (heading.getBoundingClientRect().width > 0) visibleDropdownsOpen++;
    });

    document.querySelectorAll('.cmr-all-logs .cmr-pre-heading:not(.cmr-pre-heading-active)').forEach((heading)=>{
        if (heading.getBoundingClientRect().width > 0) visibleDropdownsClosed++;
    });

    if(visibleDropdowns === visibleDropdownsOpen){
        document.querySelector('#cmr-open-all').classList.add('cmr-disabled');
    }
        
    if(visibleDropdowns === visibleDropdownsClosed){
        document.querySelector('#cmr-close-all').classList.add('cmr-disabled');
    }
};

[...document.querySelectorAll('.cmr-pre-heading')].forEach((heading, index) => {
    const thisIndex = index;
                
    heading.addEventListener('click', (e) => {
      const topTarget=e.target.getBoundingClientRect().top;                            
      heading.classList.toggle('cmr-pre-heading-active');

      const thisPre = document.querySelectorAll('#cmr-pre-content')[thisIndex];
      const thisArr = document.querySelectorAll('#cmr-arr-content')[thisIndex];

      if (thisPre.style.display === 'none') {
        thisPre.style.removeProperty('display');
        thisArr.innerHTML = '⬇️';
      } else {
        thisPre.style.display = 'none';
        thisArr.innerHTML = '➡️';

        window.scrollTo(0,0);
        const currentTop=e.target.getBoundingClientRect().top;
        window.scrollBy(0,currentTop-topTarget);
      }
        
      handleOpenCloseAllButtons();
    });
});

handleOpenCloseAllButtons();

function getScrollHeightFromBottom(){
    return Math.ceil(document.documentElement.scrollHeight - window.innerHeight - window.pageYOffset);
}

document.querySelector('#cmr-open-all').addEventListener('click', () => {
    const scrollBef=getScrollHeightFromBottom();
    [...document.querySelectorAll('.cmr-pre-heading:not(.cmr-pre-heading-active)')].forEach((heading)=>{heading.click()});
    window.scrollTo(0,999999999);
    window.scrollBy(0,-scrollBef);
});

document.querySelector('#cmr-close-all').addEventListener('click', () => {
    const scrollBef=getScrollHeightFromBottom();
    [...document.querySelectorAll('.cmr-pre-heading-active')].forEach((heading)=>{heading.click()});
    window.scrollTo(0,999999999);
    window.scrollBy(0,-scrollBef);
});

const cmrHeadline = document.querySelector('div.cmr-content > :first-child');
cmrHeadline.addEventListener('click', (event) => {
    document.querySelectorAll('.cmr-summary').forEach(element => {
        element.classList.toggle('cmr-hidden');
    });

    let collapseIcon = document.querySelector('#cmr-collapse');
    collapseIcon.innerText = collapseIcon.innerText === '⬇️' ? '➡️' : '⬇️';
});

if (window.cmrReportOptions && window.cmrReportOptions.expandHeader) {
    cmrHeadline.click();
}

const resizeAllureEls=()=>{
    const element1 = document.querySelector('#content');

    const element2 = document.querySelector('allure-side-nav');
    const rect1 = element1.getBoundingClientRect();

    // Height within current viewport
    let visibleHeight = Math.min(rect1.bottom, window.innerHeight) - Math.max(rect1.top, 0);
    visibleHeight = Math.max(0, visibleHeight); // Ensure non-negative

    document.getElementById('cmr-layout-hacks').innerHTML = `allure-side-nav { max-height: ${visibleHeight}px !important; margin-top: ${rect1.top < 0 ? -rect1.top + 'px !important' : '0px !important'}; }`;
}

window.addEventListener("resize", function(event) {
    resizeAllureEls();
});
window.addEventListener("scroll", function(event) {
    resizeAllureEls();
});
window.addEventListener("click", function(event) {
    resizeAllureEls();
});
document.addEventListener("DOMContentLoaded", (event) => {
    resizeAllureEls();
});

const footerHacks=document.querySelector('#cmr-footer-hacks').innerHTML;
document.querySelector('#cmr-checkbox-show-errors-only').addEventListener('change', (event) => {
    const scrollBef=getScrollHeightFromBottom();
    document.querySelector('#cmr-footer-hacks').innerHTML = event.target.checked ? footerHacks : '';
    window.scrollTo(0,999999999);
    window.scrollBy(0,-scrollBef);
    handleOpenCloseAllButtons();
});

if(!document.querySelector('.cmr-thread.cmr-success')){
    document.querySelector('#cmr-show-errors-only').classList.add('cmr-disabled');
}

if (typeof snapdom !== 'undefined'){
    document.getElementById('cmr-take-screenshot').style.display='block';
}

async function copyImgElementToClipboard(imgElement) {
    try {
        const canvas = document.createElement("canvas");
        canvas.width = imgElement.naturalWidth;
        canvas.height = imgElement.naturalHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(imgElement, 0, 0);

        const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
        const clipboardItem = new ClipboardItem({ "image/png": blob });
        await navigator.clipboard.write([clipboardItem]);
        
        console.log("Image from <img> copied!");
    } catch (err) {
        console.error("Error copying image from <img>", err);
    }
}

// insecure pages may disable the clipboard API, so we hide the copy button if the API isn't available
if (typeof ClipboardItem !== 'function'){
    document.getElementById('cmr-copy-to-clipboard').style.display='none';
}

document.getElementById('cmr-download').addEventListener("click", () => {
    const imgElement = document.querySelector("#cmr-screenshot-output");
    const link = document.createElement("a");
    link.href = imgElement.src;
    link.download = imgElement.title + ".png";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
});

document.getElementById('cmr-copy-to-clipboard').addEventListener("click", () => {
    copyImgElementToClipboard(document.querySelector("#cmr-screenshot-output"));
    document.getElementById('cmr-copied-to-clipboard').style.display='block';
    setTimeout(() => {
        document.getElementById('cmr-copied-to-clipboard').style.display='none';
    }, 2000);
});

document.getElementById('cmr-screenshot-modal-close').addEventListener("click", () => {
    document.getElementById('cmr-screenshot-modal').style.display='none';
});

document.getElementById('cmr-take-screenshot').addEventListener("click", () => {
    document.getElementById('cmr-take-screenshot').innerHTML = 'Please wait...';
    setTimeout(() => {
        document.querySelectorAll('body > :not(.cmr-header):not(#content):not(#cmr-screenshot-modal)').forEach(node=>{
            node.setAttribute('data-cmr-style', node.getAttribute('style') || '');
            node.setAttribute('style', 'display:none!important');
        });
        document.querySelectorAll('.widget__subtitle').forEach(node=>{
            node.setAttribute('data-cmr-style', node.getAttribute('style') || '');
            node.setAttribute('style', 'display:block');
        });
        document.getElementById('cmr-take-screenshot').innerHTML = window.cmrReportOptions.screenshotText;
        snapdom.toPng(document.body).then(img => {
            document.getElementById('cmr-screenshot-output').src = img.src;
            document.getElementById('cmr-screenshot-modal').style.display='block';
            document.querySelectorAll('[data-cmr-style]').forEach(node=>{
                node.setAttribute('style', node.getAttribute('data-cmr-style') || '');
            });
        });
    }, 0);
});

document.addEventListener('click', e => {
    if (e.target.id === 'cmr-screenshot-modal') {
        document.getElementById('cmr-screenshot-modal').style.display='none';
    }
})

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        document.getElementById('cmr-screenshot-modal').style.display='none';
    }
});
