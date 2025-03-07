# Find the start and end indices of the code block
    start_index = response_text.find("```") + 3  
    end_index = response_text.rfind("```") 

    # Extract the code
    extracted_code = response_text[start_index:end_index]
    print(extracted_code) 